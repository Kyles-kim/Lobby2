"""알림이 울리지 않을 때 원인을 찾는 읽기 전용 진단. DB를 바꾸지 않는다.

GitHub Actions의 "Lobby 서버 배포"를 mode=diagnose로 실행하면 부른다.
예약 작업(1분마다 서버 깨우기)·서버 응답·휴대폰 알림 등록·최근 기록의 알림 칸을 보여 준다.
비밀 값과 기록 제목·내용은 출력하지 않는다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from db_migrate import query  # noqa: E402


def show(title, sql):
    print(f"\n## {title}")
    try:
        rows = query(sql)
    except SystemExit as e:
        print(f"(읽지 못함: {e})")
        return
    if not rows:
        print("(없음)")
    for r in rows:
        print(" | ".join(f"{k}={v}" for k, v in r.items()))


show("지금 시각 (한국)", "select to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') as kst")
show("예약 작업 (pg_cron)", "select jobid, jobname, schedule, active from cron.job order by jobid")
show("예약 작업 최근 실행 5건", "select d.status, left(coalesce(d.return_message, ''), 120) as msg, to_char(d.start_time at time zone 'Asia/Seoul', 'MM-DD HH24:MI:SS') as kst"
     " from cron.job_run_details d join cron.job j using (jobid) where j.jobname = 'lobby-cron' order by d.start_time desc limit 5")
show("서버 응답 최근 5건 (pg_net)", "select status_code, left(coalesce(content::text, error_msg, ''), 160) as body, to_char(created at time zone 'Asia/Seoul', 'MM-DD HH24:MI:SS') as kst"
     " from net._http_response order by created desc limit 5")
show("휴대폰 알림 받는 기기", "select count(*) as n, max(created_at) as last_added, string_agg(distinct case when ua ilike '%iphone%' then 'iPhone' when ua ilike '%android%' then 'Android' when ua ilike '%windows%' then 'Windows' when ua ilike '%mac%' then 'Mac' else 'etc' end, ',') as kinds from push_subs")
show("최근 3일 기록의 알림 칸 (제목 제외)", "select id, type, status, target_date, target_time, alarm, alarm_at, created_at from records"
     " where created_at >= to_char(now() at time zone 'Asia/Seoul' - interval '3 days', 'YYYY-MM-DD') order by created_at desc limit 20")
show("앞으로 울릴 알림", "select id, type, target_date, target_time, alarm, alarm_at from records where alarm_at <> '' order by alarm_at limit 10")
