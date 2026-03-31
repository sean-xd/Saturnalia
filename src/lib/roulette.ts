export type RoulettePocket = number;
export type RouletteBetComplexity = "simple" | "intermediate" | "advanced";

export type RouletteBetType =
  | "straight"
  | "split"
  | "street"
  | "corner"
  | "six-line"
  | "dozen"
  | "column"
  | "color"
  | "parity"
  | "range";

export type RouletteBetGroup = "straight" | "inside" | "outside";

export type RouletteBetDefinition = {
  key: string;
  label: string;
  shortLabel: string;
  type: RouletteBetType;
  group: RouletteBetGroup;
  payoutMultiplier: number;
  pockets: RoulettePocket[];
};

const RED_POCKETS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BLACK_POCKETS = new Set([2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35]);
const BASE_WHEEL_POCKETS: RoulettePocket[] = [
  0,
  32,
  15,
  19,
  4,
  21,
  2,
  25,
  17,
  34,
  6,
  27,
  13,
  36,
  11,
  30,
  8,
  23,
  10,
  5,
  24,
  16,
  33,
  1,
  20,
  14,
  31,
  9,
  22,
  18,
  29,
  7,
  28,
  12,
  35,
  3,
  26,
];

export const ROULETTE_BOARD_ROWS: number[][] = Array.from({ length: 12 }, (_, index) => {
  const start = index * 3 + 1;
  return [start, start + 1, start + 2];
});

function pocketKey(pocket: RoulettePocket) {
  return pocket >= 0 ? String(pocket) : `z${Math.abs(pocket)}`;
}

export function createRouletteZeroPockets(zeroes: number) {
  return Array.from({ length: Math.max(0, zeroes) }, (_, index) => -index as RoulettePocket);
}

export function formatRoulettePocket(pocket: RoulettePocket) {
  if (pocket > 0) {
    return String(pocket);
  }

  return "0".repeat(Math.abs(pocket) + 1);
}

export function formatRouletteZeroes(zeroes: number) {
  if (zeroes <= 0) {
    return "none";
  }

  return createRouletteZeroPockets(zeroes).map(formatRoulettePocket).join(", ");
}

export function getRoulettePocketColor(pocket: RoulettePocket) {
  if (pocket <= 0) {
    return "green" as const;
  }

  if (RED_POCKETS.has(pocket)) {
    return "red" as const;
  }

  if (BLACK_POCKETS.has(pocket)) {
    return "black" as const;
  }

  return "green" as const;
}

export function getRouletteWheelPockets(zeroes: number) {
  const zeroPockets = createRouletteZeroPockets(zeroes);
  const standardPockets = BASE_WHEEL_POCKETS.filter((pocket) => pocket !== 0);

  if (zeroPockets.length === 0) {
    return standardPockets;
  }

  const totalPocketCount = standardPockets.length + zeroPockets.length;
  const zeroPositions = new Set(
    zeroPockets.map((_, index) => Math.floor((index * totalPocketCount) / zeroPockets.length)),
  );
  const wheelPockets: RoulettePocket[] = [];
  let zeroIndex = 0;
  let standardIndex = 0;

  for (let index = 0; index < totalPocketCount; index += 1) {
    if (zeroPositions.has(index)) {
      wheelPockets.push(zeroPockets[zeroIndex] ?? zeroPockets[0]);
      zeroIndex += 1;
      continue;
    }

    wheelPockets.push(standardPockets[standardIndex] ?? standardPockets[0]);
    standardIndex += 1;
  }

  return wheelPockets;
}

export function getRouletteBetDefinitions(zeroes: number): RouletteBetDefinition[] {
  const zeroPockets = createRouletteZeroPockets(zeroes);
  const definitions: RouletteBetDefinition[] = [];

  zeroPockets.forEach((pocket) => {
    const label = formatRoulettePocket(pocket);

    definitions.push({
      key: `straight:${pocketKey(pocket)}`,
      label: `${label} Straight Up`,
      shortLabel: label,
      type: "straight",
      group: "straight",
      payoutMultiplier: 35,
      pockets: [pocket],
    });
  });

  for (let number = 1; number <= 36; number += 1) {
    definitions.push({
      key: `straight:${number}`,
      label: `${number} Straight Up`,
      shortLabel: String(number),
      type: "straight",
      group: "straight",
      payoutMultiplier: 35,
      pockets: [number],
    });
  }

  ROULETTE_BOARD_ROWS.forEach((row, rowIndex) => {
    row.forEach((number, columnIndex) => {
      if (columnIndex < row.length - 1) {
        const right = row[columnIndex + 1];
        definitions.push({
          key: `split:${number}-${right}`,
          label: `Split ${number}/${right}`,
          shortLabel: `${number}/${right}`,
          type: "split",
          group: "inside",
          payoutMultiplier: 17,
          pockets: [number, right],
        });
      }

      if (rowIndex < ROULETTE_BOARD_ROWS.length - 1) {
        const below = ROULETTE_BOARD_ROWS[rowIndex + 1][columnIndex];
        definitions.push({
          key: `split:${number}-${below}`,
          label: `Split ${number}/${below}`,
          shortLabel: `${number}/${below}`,
          type: "split",
          group: "inside",
          payoutMultiplier: 17,
          pockets: [number, below],
        });
      }

      if (rowIndex < ROULETTE_BOARD_ROWS.length - 1 && columnIndex < row.length - 1) {
        const right = row[columnIndex + 1];
        const below = ROULETTE_BOARD_ROWS[rowIndex + 1][columnIndex];
        const belowRight = ROULETTE_BOARD_ROWS[rowIndex + 1][columnIndex + 1];

        definitions.push({
          key: `corner:${number}-${right}-${below}-${belowRight}`,
          label: `Corner ${number}/${right}/${below}/${belowRight}`,
          shortLabel: `${number}-${belowRight}`,
          type: "corner",
          group: "inside",
          payoutMultiplier: 8,
          pockets: [number, right, below, belowRight],
        });
      }
    });

    definitions.push({
      key: `street:${row.join("-")}`,
      label: `Street ${row[0]}-${row[2]}`,
      shortLabel: `${row[0]}-${row[2]}`,
      type: "street",
      group: "inside",
      payoutMultiplier: 11,
      pockets: [...row],
    });

    if (rowIndex < ROULETTE_BOARD_ROWS.length - 1) {
      const nextRow = ROULETTE_BOARD_ROWS[rowIndex + 1];
      definitions.push({
        key: `six:${row[0]}-${nextRow[2]}`,
        label: `Six Line ${row[0]}-${nextRow[2]}`,
        shortLabel: `${row[0]}-${nextRow[2]}`,
        type: "six-line",
        group: "inside",
        payoutMultiplier: 5,
        pockets: [...row, ...nextRow],
      });
    }
  });

  definitions.push(
    {
      key: "dozen:1",
      label: "1st Dozen",
      shortLabel: "1st 12",
      type: "dozen",
      group: "outside",
      payoutMultiplier: 2,
      pockets: Array.from({ length: 12 }, (_, index) => index + 1),
    },
    {
      key: "dozen:2",
      label: "2nd Dozen",
      shortLabel: "2nd 12",
      type: "dozen",
      group: "outside",
      payoutMultiplier: 2,
      pockets: Array.from({ length: 12 }, (_, index) => index + 13),
    },
    {
      key: "dozen:3",
      label: "3rd Dozen",
      shortLabel: "3rd 12",
      type: "dozen",
      group: "outside",
      payoutMultiplier: 2,
      pockets: Array.from({ length: 12 }, (_, index) => index + 25),
    },
    {
      key: "column:1",
      label: "1st Column",
      shortLabel: "Col 1",
      type: "column",
      group: "outside",
      payoutMultiplier: 2,
      pockets: Array.from({ length: 12 }, (_, index) => index * 3 + 1),
    },
    {
      key: "column:2",
      label: "2nd Column",
      shortLabel: "Col 2",
      type: "column",
      group: "outside",
      payoutMultiplier: 2,
      pockets: Array.from({ length: 12 }, (_, index) => index * 3 + 2),
    },
    {
      key: "column:3",
      label: "3rd Column",
      shortLabel: "Col 3",
      type: "column",
      group: "outside",
      payoutMultiplier: 2,
      pockets: Array.from({ length: 12 }, (_, index) => index * 3 + 3),
    },
    {
      key: "range:low",
      label: "1 to 18",
      shortLabel: "1-18",
      type: "range",
      group: "outside",
      payoutMultiplier: 1,
      pockets: Array.from({ length: 18 }, (_, index) => index + 1),
    },
    {
      key: "range:high",
      label: "19 to 36",
      shortLabel: "19-36",
      type: "range",
      group: "outside",
      payoutMultiplier: 1,
      pockets: Array.from({ length: 18 }, (_, index) => index + 19),
    },
    {
      key: "parity:even",
      label: "Even",
      shortLabel: "Even",
      type: "parity",
      group: "outside",
      payoutMultiplier: 1,
      pockets: Array.from({ length: 18 }, (_, index) => (index + 1) * 2),
    },
    {
      key: "parity:odd",
      label: "Odd",
      shortLabel: "Odd",
      type: "parity",
      group: "outside",
      payoutMultiplier: 1,
      pockets: Array.from({ length: 18 }, (_, index) => index * 2 + 1),
    },
    {
      key: "color:red",
      label: "Red",
      shortLabel: "Red",
      type: "color",
      group: "outside",
      payoutMultiplier: 1,
      pockets: [...RED_POCKETS],
    },
    {
      key: "color:black",
      label: "Black",
      shortLabel: "Black",
      type: "color",
      group: "outside",
      payoutMultiplier: 1,
      pockets: [...BLACK_POCKETS],
    },
  );

  return definitions;
}

export function getRouletteBetDefinitionMap(zeroes: number) {
  return new Map(getRouletteBetDefinitions(zeroes).map((definition) => [definition.key, definition]));
}

export function filterRouletteBetDefinitionsByComplexity(
  definitions: RouletteBetDefinition[],
  complexity: RouletteBetComplexity,
) {
  if (complexity === "simple") {
    return definitions.filter((definition) => definition.key === "color:red" || definition.key === "color:black");
  }

  if (complexity === "intermediate") {
    return definitions.filter((definition) => definition.type === "straight" || definition.key === "color:red" || definition.key === "color:black");
  }

  return definitions;
}