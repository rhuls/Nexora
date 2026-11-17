import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { BlackjackIntelligenceService, ObservationRejected, SOLVER_VERSION } from '../../src/services/blackjack-intelligence.service.js';
import { DEFAULT_RULES } from '../../src/blackjack/types.js';

const prisma = new PrismaClient();
const service = new BlackjackIntelligenceService(prisma);
const rules = DEFAULT_RULES;
// Ranks: 0 = ace, 1..8 = two..nine, 9 = any ten-value card.
const hand = {
  rules,
  seen: [] as number[],
  playerCards: [9, 5],     // T,6 = hard 16
  dealerUpcard: 5,         // 6
  dealerFinalCards: [5, 8, 4], // 6,9,5 = 20
  playerFinalCards: [9, 5],
  stake: 1,
  surrendered: false,
  predictedAt: new Date(),
};

afterAll(async () => {
  await prisma.$disconnect();
});

describe('what may become an observation', () => {
  it('refuses a hand the forecast was never about', async () => {
    // With peek, a dealer natural ends the hand before anyone acts, and the dealer distribution is
    // conditioned on the dealer not holding one.
    await expect(service.recordPlayed({ ...hand, dealerFinalCards: [9, 0], dealerUpcard: 9 }))
      .rejects.toBeInstanceOf(ObservationRejected);
    await expect(service.recordPlayed({ ...hand, playerCards: [0, 9], playerFinalCards: [0, 9] }))
      .rejects.toBeInstanceOf(ObservationRejected);
  });

  it('refuses a hand that does not describe itself consistently', async () => {
    await expect(service.recordPlayed({ ...hand, dealerFinalCards: [3, 8, 4] }))
      .rejects.toBeInstanceOf(ObservationRejected);
    await expect(service.recordPlayed({ ...hand, playerFinalCards: [1, 2] }))
      .rejects.toBeInstanceOf(ObservationRejected);
  });

  it('recomputes the forecast here rather than taking the caller’s word for it', async () => {
    const { observation } = await service.recordPlayed(hand);
    expect(observation.dealerDistribution).toHaveLength(6);
    expect(observation.dealerDistribution.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 10);
    // 6,9,5 is twenty, which is the fourth of 17/18/19/20/21/bust.
    expect(observation.dealerOutcome).toBe(3);
    expect(observation.settled).toBe('lose');
    expect(observation.source).toBe('PLAYED');
    // Everything needed to recompute the forecast is stored with it.
    expect(observation.remaining.reduce((sum, c) => sum + c, 0)).toBe(rules.decks * 52 - 3);
  });
});

describe('the record cannot be revised', () => {
  it('refuses an update, because a forecast that can be edited afterwards is not evidence', async () => {
    const { observation } = await service.recordPlayed(hand);
    const row = await prisma.blackjackObservation.findFirstOrThrow({
      where: { source: 'PLAYED', dealerOutcome: observation.dealerOutcome },
      orderBy: { recordedAt: 'desc' },
    });
    await expect(prisma.blackjackObservation.update({ where: { id: row.id }, data: { net: 99 } })).rejects.toThrow(/immutable/);
    await expect(prisma.blackjackObservation.delete({ where: { id: row.id } })).rejects.toThrow(/immutable/);
  });

  it('keeps a model version that has observations behind it', async () => {
    const version = await prisma.blackjackModelVersion.findFirstOrThrow({ where: { version: SOLVER_VERSION(rules) } });
    await expect(prisma.blackjackModelVersion.delete({ where: { id: version.id } })).rejects.toThrow(/retire it instead/);
  });

  it('returns the same baseline version rather than making a second one', async () => {
    const a = await service.solverVersion(rules);
    const b = await service.solverVersion(rules);
    expect(a.id).toBe(b.id);
    expect(await prisma.blackjackModelVersion.count({ where: { version: SOLVER_VERSION(rules) } })).toBe(1);
  });

  it('keeps versions for different rules apart, because the correct forecast differs', async () => {
    const other = await service.solverVersion({ ...rules, hitSoft17: true });
    const base = await service.solverVersion(rules);
    expect(other.id).not.toBe(base.id);
    expect(other.version).toContain('h17');
    expect(base.version).toContain('s17');
  });
});
