# -*- coding: utf-8 -*-
"""Работа с API Coolify: создание приложения, переменные окружения, деплой.

Токен берётся из Доступы.md. Внутри файла кириллица записана \\u-escape-кодами,
чтобы файл переживал пересохранение в любой кодировке.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

KARTA = "\u041a\u0410\u0420\u0422\u0410.md"          # КАРТА.md
ACCESS_DIR = "00_\u041a\u043e\u043d\u0442\u0435\u043a\u0441\u0442"  # 00_Контекст
ACCESS_FILE = "\u0414\u043e\u0441\u0442\u0443\u043f\u044b.md"        # Доступы.md

BASE = "https://coolify.admin.tridavinci.org/api/v1"
APP_NAME = "inbox"
REPO = "https://github.com/spokoistvie-cyber/inbox"
BRANCH = "main"
DOMAIN = "https://inbox.app.tridavinci.org"


def root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / KARTA).exists():
            return parent
    sys.exit("не нашёл корень базы (КАРТА.md)")


def token() -> str:
    text = (root() / ACCESS_DIR / ACCESS_FILE).read_text(encoding="utf-8")
    m = re.search(r"\u0417\u043d\u0430\u0447\u0435\u043d\u0438\u0435 \u0442\u043e\u043a\u0435\u043d\u0430:\s*`([^`]+)`", text)
    if not m:
        sys.exit("в Доступы.md не найден токен Coolify")
    return m.group(1)


def api(method: str, path: str, body=None):
    data = None
    headers = {"Authorization": "Bearer " + token(), "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, method, path, e.read().decode("utf-8")[:800])
        raise


def as_list(data):
    return data if isinstance(data, list) else (data.get("data") or [])


def find_app():
    for a in as_list(api("GET", "/applications")):
        if a.get("name") == APP_NAME:
            return a
    return None


def cmd_list():
    print("PROJECTS:")
    for p in as_list(api("GET", "/projects")):
        print(" ", p.get("uuid"), "|", p.get("name"))
    print("SERVERS:")
    for s in as_list(api("GET", "/servers")):
        print(" ", s.get("uuid"), "|", s.get("name"), "|", s.get("ip"))
    print("DESTINATIONS:")
    for d in as_list(api("GET", "/destinations")):
        print(" ", d.get("uuid"), "|", d.get("name"), "| server:", d.get("server_uuid"))


def cmd_create():
    if find_app():
        print("приложение уже есть")
        return
    projects = as_list(api("GET", "/projects"))
    proj = next((p for p in projects if p.get("name") == "Inbox"), None)
    if not proj:
        proj = api("POST", "/projects", {"name": "Inbox", "description": "PWA vkhodyashchie - otpravka v Dropbox"})
        print("проект создан:", proj.get("uuid"))
    servers = as_list(api("GET", "/servers"))
    server = next((s for s in servers if s.get("name") == "worker"), servers[0])
    dests = as_list(api("GET", "/destinations"))
    dest = next((d for d in dests if d.get("server_uuid") == server["uuid"]), None)
    if not dest:
        sys.exit("не нашёл destination для сервера " + server["uuid"])
    body = {
        "project_uuid": proj["uuid"],
        "server_uuid": server["uuid"],
        "environment_name": "production",
        "destination_uuid": dest["uuid"],
        "git_repository": REPO,
        "git_branch": BRANCH,
        "build_pack": "dockerfile",
        "ports_exposes": "3000",
        "domains": DOMAIN,
        "name": APP_NAME,
        "description": "Vkhodyashchie: message and files to Dropbox",
    }
    app = api("POST", "/applications/public", body)
    print("приложение создано:", app.get("uuid"))
    api("PATCH", "/applications/" + app["uuid"], {"domains": DOMAIN})
    print("домен:", DOMAIN)


def cmd_env_set():
    app = find_app()
    if not app:
        sys.exit("приложения нет")
    env_file = Path(".env.local")
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if not line.strip() or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip("'")
        body = {"key": key, "value": value, "is_runtime": True,
                "is_buildtime": False, "is_literal": True}
        try:
            api("POST", f"/applications/{app['uuid']}/envs", body)
            print("env:", key, "ok")
        except urllib.error.HTTPError as e:
            print("env:", key, "HTTP", e.code)
    api("PATCH", f"/applications/{app['uuid']}", {"domains": DOMAIN})


def cmd_deploy():
    app = find_app()
    if not app:
        sys.exit("приложения нет — сначала create")
    d = api("POST", f"/deploy?uuid={app['uuid']}&force=false")
    dep = (d.get("deployments") or [{}])[0] if isinstance(d, dict) else {}
    uid = dep.get("deployment_uuid") or d.get("deployment_uuid")
    print("деплой:", uid)
    for _ in range(120):
        st = api("GET", "/deployments/" + uid)
        status = st.get("status")
        if status and status != "in_progress":
            print("  ", status)
        if status in ("finished", "success", "failed", "error", "cancelled"):
            if status not in ("finished", "success"):
                print((st.get("logs") or "")[-5000:])
            return
        time.sleep(5)
    print("деплой не завершился за отведённое время")


def cmd_app():
    app = find_app()
    if not app:
        print("нет приложения")
        return
    keys = ("uuid", "name", "fqdn", "domains", "git_repository", "git_branch",
            "build_pack", "status", "ports_exposes")
    print(json.dumps({k: app.get(k) for k in keys}, ensure_ascii=False, indent=1))


def cmd_env_list():
    app = find_app()
    print(json.dumps(api("GET", f"/applications/{app['uuid']}/envs"), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "app"
    {
        "list": cmd_list,
        "create": cmd_create,
        "env-set": cmd_env_set,
        "env": cmd_env_list,
        "deploy": cmd_deploy,
        "app": cmd_app,
    }[cmd]()
