-- 자동 실행 등록: 1분마다 서버를 깨워 일정 알림(휴대폰 알림)·예약 작업(아침 브리핑·밤 보고서 포함)·휴지통 정리를 수행한다.
-- 서버(Edge Function)를 배포하고 CRON_SECRET을 등록한 뒤, Supabase 대시보드 > SQL Editor에서 한 번 실행한다.
-- 예전에 15분 간격으로 등록해 두었다면 이 파일을 다시 실행하면 1분 간격으로 바뀐다(알림이 제시간에 오려면 필요).
-- <PROJECT_REF>와 <CRON_SECRET> 두 곳을 실제 값으로 바꿔서 실행할 것. (바꾼 내용은 저장소에 올리지 않는다)

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'lobby-cron';

select cron.schedule(
  'lobby-cron',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/api',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "cron", "secret": "<CRON_SECRET>"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
