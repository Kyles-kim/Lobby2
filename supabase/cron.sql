-- 자동 실행 등록: 15분마다 서버를 깨워 예약 작업(아침 브리핑·밤 보고서 포함)과 휴지통 정리를 수행한다.
-- 서버(Edge Function)를 배포하고 CRON_SECRET을 등록한 뒤, Supabase 대시보드 > SQL Editor에서 한 번 실행한다.
-- <PROJECT_REF>와 <CRON_SECRET> 두 곳을 실제 값으로 바꿔서 실행할 것. (바꾼 내용은 저장소에 올리지 않는다)

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'lobby-cron';

select cron.schedule(
  'lobby-cron',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/api',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "cron", "secret": "<CRON_SECRET>"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
