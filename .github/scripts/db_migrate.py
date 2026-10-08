"""supabase/migrations/의 SQL 파일 중 아직 실행하지 않은 것을 날짜 순서대로 Lobby DB에 실행한다.

GitHub Actions의 "Lobby 서버 배포"가 서버 배포 전에 부른다. Supabase Management API로 SQL을 보내므로
SQL Editor에 직접 붙여넣는 것과 같다. 실행한 파일 이름은 DB의 schema_migrations 표에 남겨 두고 다시 실행하지 않는다.

필요한 환경 변수: SB_TOKEN (Supabase Access Token), SB_REF (프로젝트 ID)
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase" / "migrations"
INIT = "20261005000000_init.sql"


def query(sql: str):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{os.environ['SB_REF']}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": "Bearer " + os.environ["SB_TOKEN"], "Content-Type": "application/json", "User-Agent": "lobby2-deploy"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"[]")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        if e.code in (401, 403):
            raise SystemExit(f"::error::토큰에 DB 권한이 없어 표 업데이트를 하지 못했습니다 (HTTP {e.code}). Supabase Access Tokens에서 전체 권한 토큰을 만들어 등록해 주세요.")
        raise SystemExit(f"::error::SQL 실행 실패 (HTTP {e.code}): {body}")


def main():
    files = sorted(p for p in MIGRATIONS.glob("*.sql"))
    fresh = not query("select to_regclass('public.schema_migrations') is not null as ok")[0]["ok"]
    query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now());"
          " alter table schema_migrations enable row level security;")
    if fresh and query("select to_regclass('public.records') is not null as ok")[0]["ok"]:
        # 이 기능 전에 SQL Editor로 설치해 둔 DB: init.sql은 이미 실행된 것으로 본다
        # (다시 실행하면 지워 둔 기본 분류·예약 작업이 되살아나므로). 나머지 파일은 다시 실행해도 안전하다.
        query(f"insert into schema_migrations (name) values ('{INIT}') on conflict do nothing")
    done = {r["name"] for r in query("select name from schema_migrations")}
    todo = [p for p in files if p.name not in done]
    if not todo:
        print("표 업데이트: 새로 실행할 SQL 없음")
        return
    for p in todo:
        name = p.name.replace("'", "''")
        query(p.read_text(encoding="utf-8") + f"\n;insert into schema_migrations (name) values ('{name}') on conflict do nothing;")
        print(f"표 업데이트 실행: {p.name}")


if __name__ == "__main__":
    if not os.environ.get("SB_TOKEN") or not os.environ.get("SB_REF"):
        sys.exit("::error::SB_TOKEN / SB_REF 값이 없습니다.")
    main()
