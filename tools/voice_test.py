# -*- coding: utf-8 -*-
"""Проверка расшифровки голосовых через Dropbox (riviera/get_transcript_async).

Загружает тестовый wav во «Входящие», запускает расшифровку, ждёт результат,
печатает текст и удаляет тестовый файл.
"""
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[5]  # .../База
TOKEN = json.loads((ROOT / "_Инструменты" / "dropbox-mcp" / "token.json").read_text(encoding="utf-8"))
DIR = "/Галина Старченко/Архив Claude/База/99_Входящие"
NAME = "2026-11-13 — тест расшифровки (DSH).wav"
WAV = pathlib.Path(__file__).resolve().parent / "_samples" / "jfk.wav"
WAV.parent.mkdir(exist_ok=True)

ACCESS = ""


def api(url, body=None, content_type="application/json", raw=False):
    data = None if body is None else (body if raw else json.dumps(body).encode("utf-8"))
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": "Bearer " + ACCESS,
        "Content-Type": content_type,
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def refresh():
    global ACCESS
    form = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": TOKEN["refreshToken"],
        "client_id": TOKEN["appKey"],
    }).encode()
    ACCESS = json.loads(api("https://api.dropboxapi.com/oauth2/token", form,
                            "application/x-www-form-urlencoded", raw=True))["access_token"]


def arg(obj):
    import re
    return re.sub(r"[^\x00-\x7f]", lambda m: "\\u%04x" % ord(m.group(0)),
                  json.dumps(obj, ensure_ascii=False))


def upload(path, file_path):
    data = pathlib.Path(file_path).read_bytes()
    req = urllib.request.Request("https://content.dropboxapi.com/2/files/upload", data=data, headers={
        "Authorization": "Bearer " + ACCESS,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": arg({"path": path, "mode": "add", "autorename": True, "mute": True}),
    })
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def delete(path):
    req = urllib.request.Request("https://api.dropboxapi.com/2/files/delete_v2",
                                 data=json.dumps({"path": path}).encode(),
                                 headers={"Authorization": "Bearer " + ACCESS,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def main():
    refresh()
    if not WAV.exists():
        urllib.request.urlretrieve("https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav", str(WAV))
    info = upload(f"{DIR}/{NAME}", WAV)
    print("загружено:", info["path_display"], info["size"], "байт")

    start = json.loads(api("https://api.dropboxapi.com/2/riviera/get_transcript_async", {
        "file_id_or_url": {".tag": "path", "path": f"{DIR}/{NAME}"},
        "timestamp_level": {".tag": "sentence"},
    }))
    job = start.get("async_job_id")
    print("задача:", start.get(".tag"), job)
    if not job:
        print(start)
        return

    for attempt in range(40):
        time.sleep(3)
        st = json.loads(api("https://api.dropboxapi.com/2/riviera/get_transcript_async/check",
                            {"async_job_id": job}))
        tag = st.get(".tag")
        if tag == "complete":
            tr = st.get("structured_transcript") or {}
            segs = tr.get("segments") or []
            print("язык:", tr.get("transcript_locale"))
            print("расшифровка:", " ".join(s.get("text", "") for s in segs)[:400])
            break
        if tag == "failed":
            print("не удалось:", json.dumps(st.get("failed"), ensure_ascii=False)[:300])
            break
        print("  ещё обрабатывается…")
    print("удаление:", delete(f"{DIR}/{NAME}"))


if __name__ == "__main__":
    main()
    sys.exit(0)
