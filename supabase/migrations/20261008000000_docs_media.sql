-- Lobby2 회사 문서: 품번·메모
-- Supabase 대시보드 > SQL Editor에 붙여넣고 한 번 실행한다. (여러 번 실행해도 안전)
-- 휴대폰으로 찍은 사진(IMG_1234.jpg)처럼 파일 이름만으로는 무엇인지 알 수 없는 파일에
-- "CR-747 제품사진" 같은 품번·메모를 달아 두면, 물을 때 그 말로 찾아서 보여 준다.
alter table docs add column if not exists memo text not null default '';
