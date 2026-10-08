import { describe, expect, test } from 'vitest';
import { buildEarlyoomArgs } from '../earlyoom';
import { DEFAULT_THRESHOLDS, parseEarlyoomThresholds, readEarlyoomThresholds, thresholdKB } from './earlyoom';

const GO = 1024 * 1024;

describe('parseEarlyoomThresholds', () => {
  test.each([
    ['EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|zsh)$ --prefer ^(node|npm)$"', 8, 35],
    ['#EARLYOOM_ARGS="-m 20"\nEARLYOOM_ARGS="-m 4 -s 10"', 4, 10],
    ['EARLYOOM_ARGS="-m 20 -s 50"\nEARLYOOM_ARGS="-m 4 -s 10"', 4, 10],
    ["EARLYOOM_ARGS='-m 6 -s 20'", 6, 20],
    ['EARLYOOM_ARGS=-m 6 -s 20', 6, 20],
    ['EARLYOOM_ARGS="-m4 -s 12"', 4, 12],
    ['EARLYOOM_ARGS="-m 4.5 -s 20.5"', 4.5, 20.5],
    ['EARLYOOM_ARGS="--mem=6 --swap 30"', 6, 30],
  ])('%s → %d / %d', (text, mem, swap) => {
    expect(parseEarlyoomThresholds(text)).toMatchObject({ memPercent: mem, swapPercent: swap, source: 'file' });
  });

  test('fichier absent, vide, binaire ou sans EARLYOOM_ARGS → 8 % / 35 %, source default', () => {
    expect(parseEarlyoomThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseEarlyoomThresholds('')).toEqual(DEFAULT_THRESHOLDS);
    expect(parseEarlyoomThresholds('garbage\n\0\xff')).toEqual(DEFAULT_THRESHOLDS);
    expect(parseEarlyoomThresholds('#EARLYOOM_ARGS="-m 20"')).toEqual(DEFAULT_THRESHOLDS);
    expect(DEFAULT_THRESHOLDS).toMatchObject({ memPercent: 8, swapPercent: 35, memKB: null, swapKB: null, source: 'default' });
  });

  test.each([
    ['EARLYOOM_ARGS="-m abc -s"', 8, 35],
    ['EARLYOOM_ARGS="-m 0 -s 20"', 8, 20],
    ['EARLYOOM_ARGS="-m 150 -s 200"', 8, 35],
    ['EARLYOOM_ARGS="-m -5 -s 20"', 8, 20],
    ['EARLYOOM_ARGS="-m 4.5.1 -s 1e2"', 8, 35],
  ])('valeur invalide → 8 / 35 pour ce champ : %s', (text, mem, swap) => {
    expect(parseEarlyoomThresholds(text)).toMatchObject({ memPercent: mem, swapPercent: swap });
  });

  test('option absente d’une ligne existante → défaut d’earlyoom lui-même (10 %)', () => {
    expect(parseEarlyoomThresholds('EARLYOOM_ARGS="-m 5"')).toMatchObject({ memPercent: 5, swapPercent: 10, source: 'file' });
    expect(parseEarlyoomThresholds('EARLYOOM_ARGS="-r 60"')).toMatchObject({ memPercent: 10, swapPercent: 10 });
  });

  test.each([
    ['EARLYOOM_ARGS="-m 8 --prefer ^(x -m 50)$"', 8, 10],
    ['EARLYOOM_ARGS="-m 8 -s 35 --avoid -s"', 8, 35],
    ['EARLYOOM_ARGS="-m 8 -s 35 --ignore ^(a -s 1|b)$ -r 5"', 8, 35],
    ['EARLYOOM_ARGS="--prefer=^(x -m 50)$ -m 7"', 7, 10],
    ['EARLYOOM_ARGS="-m 8 -s 35 -N /bin/x -p -g -n --sort-by-rss --syslog -r 0"', 8, 35],
  ])('pièges : les valeurs de --prefer/--avoid/--ignore/-N/-r ne sont pas lues comme options : %s', (text, mem, swap) => {
    expect(parseEarlyoomThresholds(text)).toMatchObject({ memPercent: mem, swapPercent: swap });
  });

  test('-M / -S (Kio) : lus, seuils SIGTERM (1er nombre) ; invalides ignorés', () => {
    expect(parseEarlyoomThresholds('EARLYOOM_ARGS="-M 2097152 -S 1000000"')).toMatchObject({ memKB: 2097152, swapKB: 1000000 });
    expect(parseEarlyoomThresholds('EARLYOOM_ARGS="-M 2097152,1048576"')).toMatchObject({ memKB: 2097152 });
    expect(parseEarlyoomThresholds('EARLYOOM_ARGS="-M abc -S -3"')).toMatchObject({ memKB: null, swapKB: null });
  });

  test('aller-retour avec le générateur de Réglages › earlyoom : mêmes seuils', () => {
    const r = buildEarlyoomArgs({ memTerm: 12, memKill: 6, swapTerm: 40, swapKill: 20, prefer: ['node', 'vitest.*'] }, ['code']);
    if (!r.ok) throw new Error(r.errors.join());
    expect(parseEarlyoomThresholds(`# généré\n${r.line}\n`)).toMatchObject({ memPercent: 12, swapPercent: 40, source: 'file' });
  });
});

test('readEarlyoomThresholds : erreur de lecture → défauts', () => {
  const enoent = () => {
    throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  };
  expect(readEarlyoomThresholds('/nope', enoent)).toEqual(DEFAULT_THRESHOLDS);
  expect(readEarlyoomThresholds('/x', () => 'EARLYOOM_ARGS="-m 5 -s 30"')).toMatchObject({ memPercent: 5, swapPercent: 30 });
});

describe('thresholdKB : seuil effectif = le plus strict (le plus bas) des deux formes, comme earlyoom', () => {
  test('pourcentages seuls', () => {
    expect(thresholdKB(DEFAULT_THRESHOLDS, { memTotalKB: 32_000_000, swapTotalKB: 20_000_000 })).toEqual({ memKB: 2_560_000, swapKB: 7_000_000 });
  });
  test('sans swap → seuil swap 0', () => {
    expect(thresholdKB(DEFAULT_THRESHOLDS, { memTotalKB: 32_000_000, swapTotalKB: 0 })).toEqual({ memKB: 2_560_000, swapKB: 0 });
  });
  test('-M 2097152 + -m 8 sur 32 Gio → min(8 %, 2 Gio) = 2 097 152 Ko', () => {
    const t = parseEarlyoomThresholds('EARLYOOM_ARGS="-m 8 -M 2097152"');
    expect(thresholdKB(t, { memTotalKB: 32 * GO, swapTotalKB: 0 }).memKB).toBe(2_097_152);
  });
  test('-M seul : la valeur en Kio (le pourcentage par défaut ne s’applique pas)', () => {
    const t = parseEarlyoomThresholds('EARLYOOM_ARGS="-M 1048576 -S 4194304"');
    expect(thresholdKB(t, { memTotalKB: 32 * GO, swapTotalKB: 20 * GO })).toEqual({ memKB: 1_048_576, swapKB: 4_194_304 });
  });
  test('-M plus grand que le pourcentage : le pourcentage gagne', () => {
    const t = parseEarlyoomThresholds('EARLYOOM_ARGS="-m 4 -M 8388608"');
    expect(thresholdKB(t, { memTotalKB: 32 * GO, swapTotalKB: 0 }).memKB).toBeCloseTo(0.04 * 32 * GO, 0);
  });
});

describe('lignes écrites à la main', () => {
  test.each([
    ['EARLYOOM_ARGS="-m 8 -s 35" # commentaire', 8, 35],
    ["EARLYOOM_ARGS='-m 6 -s 20'   # -m 50", 6, 20],
    ['EARLYOOM_ARGS=-m 7 -s 30 # -m 50', 7, 30],
    ['export EARLYOOM_ARGS="-m 5 -s 25"', 5, 25],
    ['  export   EARLYOOM_ARGS=-m 4 -s 22', 4, 22],
    ['EARLYOOM_ARGS="-m 8 --prefer (( -s 30 -r 5"', 8, 30],
    ['EARLYOOM_ARGS="--ignore ^(a|b -m 9 -s 40"', 9, 40],
    ['EARLYOOM_ARGS="-m 8 --prefer ^(x -m 50)$ -s 30"', 8, 30],
  ])('%s → %d / %d', (text, mem, swap) => {
    expect(parseEarlyoomThresholds(text)).toMatchObject({ memPercent: mem, swapPercent: swap, source: 'file' });
  });
});
