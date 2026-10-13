import { crashTimeMs } from './multiplier';
import { Round, RoundStateError } from './round';

const STARTED_AT = 1_000_000;

function runningRound(crashPoint = 200): Round {
  const round = new Round('round-1', crashPoint);
  round.start(STARTED_AT);

  return round;
}

describe('Round', () => {
  describe('BETTING', () => {
    it('starts in BETTING', () => {
      expect(new Round('round-1', 200).phase).toBe('BETTING');
    });

    it('accepts bets', () => {
      expect(() => new Round('round-1', 200).assertBettingOpen()).not.toThrow();
    });

    it('rejects cashouts', () => {
      expect(() => new Round('round-1', 200).cashOut(STARTED_AT)).toThrow(RoundStateError);
    });

    it('cannot crash before running', () => {
      expect(() => new Round('round-1', 200).crash(STARTED_AT)).toThrow(RoundStateError);
    });

    it('has no multiplier yet', () => {
      expect(() => new Round('round-1', 200).multiplier(STARTED_AT)).toThrow(RoundStateError);
    });
  });

  describe('RUNNING', () => {
    it('moves to RUNNING on start', () => {
      expect(runningRound().phase).toBe('RUNNING');
    });

    it('cannot start twice', () => {
      expect(() => runningRound().start(STARTED_AT)).toThrow(RoundStateError);
    });

    it('rejects bets', () => {
      expect(() => runningRound().assertBettingOpen()).toThrow(RoundStateError);
    });

    it('reports the multiplier from the start time', () => {
      const round = runningRound();

      expect(round.multiplier(STARTED_AT)).toBe(100);
      expect(round.multiplier(STARTED_AT + 6_479)).toBe(200);
    });

    it('rejects a time before the start', () => {
      expect(() => runningRound().multiplier(STARTED_AT - 1)).toThrow(RangeError);
    });

    it('cashes out at the current multiplier', () => {
      expect(runningRound(300).cashOut(STARTED_AT + 6_479)).toBe(200);
    });

    it('rejects a cashout once the multiplier reaches the crash point', () => {
      const round = runningRound(200);

      expect(round.cashOut(STARTED_AT + 6_478)).toBe(199);
      expect(() => round.cashOut(STARTED_AT + 6_479)).toThrow(RoundStateError);
    });

    it('never pays out on a 1.00x round', () => {
      expect(() => runningRound(100).cashOut(STARTED_AT)).toThrow(RoundStateError);
    });

    it('reports when it crashes', () => {
      expect(runningRound(200).crashesAt).toBe(STARTED_AT + crashTimeMs(200));
    });

    it('cannot crash before the crash point is reached', () => {
      const round = runningRound(200);

      expect(() => round.crash(round.crashesAt - 1)).toThrow(RoundStateError);
      expect(round.phase).toBe('RUNNING');
    });
  });

  describe('CRASHED', () => {
    function crashedRound(): Round {
      const round = runningRound(200);
      round.crash(round.crashesAt);

      return round;
    }

    it('moves to CRASHED at the crash time', () => {
      expect(crashedRound().phase).toBe('CRASHED');
    });

    it('crashes immediately on a 1.00x round', () => {
      const round = runningRound(100);
      round.crash(STARTED_AT);

      expect(round.phase).toBe('CRASHED');
    });

    it('rejects bets', () => {
      expect(() => crashedRound().assertBettingOpen()).toThrow(RoundStateError);
    });

    it('rejects cashouts', () => {
      const round = crashedRound();

      expect(() => round.cashOut(round.crashesAt)).toThrow(RoundStateError);
    });

    it('cannot crash twice', () => {
      const round = crashedRound();

      expect(() => round.crash(round.crashesAt)).toThrow(RoundStateError);
    });

    it('cannot start again', () => {
      expect(() => crashedRound().start(STARTED_AT)).toThrow(RoundStateError);
    });
  });
});
