-- Lobby2 회사 문서: 도면의 주요 치수 (전장·전폭·전고 …)
-- dims    : 한 줄에 하나씩 "전장: 358.10 (±0.2)". 도면을 읽을 때 Lobby가 채우고, 카일님이 확인·수정한다
-- dims_ok : 카일님이 확인한 일시 (비어 있으면 Lobby가 읽은 값 그대로, 확인 전)
-- (여러 번 실행해도 안전)
alter table docs add column if not exists dims text not null default '';
alter table docs add column if not exists dims_ok text not null default '';
