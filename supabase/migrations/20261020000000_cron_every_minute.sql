-- Lobby2 자동 실행 간격을 1분으로 (휴대폰 일정 알림이 제시간에 오도록)
-- 예전에 supabase/cron.sql을 15분 간격으로 등록해 둔 경우 그 예약 작업(lobby-cron)의 간격만 바꾼다.
-- 서버 주소·비밀 값은 그대로 두며, 예약 작업이 없으면 아무것도 하지 않는다. (여러 번 실행해도 안전)
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.alter_job(jobid, schedule := '* * * * *') from cron.job where jobname = 'lobby-cron' and schedule <> '* * * * *';
  end if;
end $$;
