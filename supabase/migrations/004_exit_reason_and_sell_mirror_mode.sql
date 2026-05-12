-- Sell-side copying support.
--
-- pt_trades.exit_reason — distinguishes a trade closed by the leader selling
-- ('sold') from one closed by Polymarket market settlement ('settled'). Both
-- still write status='resolved'; this column captures HOW it closed so the UI
-- can show a SOLD badge separately from WIN/LOSS, and so analytics can split
-- realized PnL by exit path. Existing resolved rows are backfilled to
-- 'settled' since up until this point we were buys-only and the only way to
-- close a position was via market resolution.
--
-- pt_registry.sell_mirror_mode — per-trader switch for how to mirror leader
-- sells. 'proportional' (default) sells the same fraction of our position the
-- leader sold (computed from their open-positions snapshot at sell time).
-- 'all_or_nothing' fully closes our position on any leader sell. Existing
-- rows default to 'proportional'.

alter table pt_trades
  add column if not exists exit_reason text
    check (exit_reason in ('sold', 'settled') or exit_reason is null);

alter table pt_trades
  add column if not exists side text
    check (side in ('buy', 'sell') or side is null);

update pt_trades
   set exit_reason = 'settled'
 where status = 'resolved'
   and exit_reason is null;

-- All trades up to this point were buy-side fills.
update pt_trades
   set side = 'buy'
 where side is null;

alter table pt_registry
  add column if not exists sell_mirror_mode text not null default 'proportional'
    check (sell_mirror_mode in ('proportional', 'all_or_nothing'));

-- New paper traders default to copying both sides now that sell-side is wired.
-- Existing rows keep whatever copy_mode they already have (most are 'buys_only'
-- from V1) so we don't retroactively change anyone's behavior. They can flip
-- via the Settings tab.
alter table pt_registry
  alter column copy_mode set default 'buys_and_sells';
