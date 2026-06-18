import { sector } from "./log-id";

const MIXTAPE_LETTERS = "ABCDEF";
const maxMixtapeSequence = 54;

export function mixtapeTail(sequenceNumber: number): string {
  if (
    !Number.isInteger(sequenceNumber) ||
    sequenceNumber < 1 ||
    sequenceNumber > maxMixtapeSequence
  ) {
    throw new Error("mixtape-log-id: sequence number must be between 1 and 54");
  }

  const digit = Math.floor((sequenceNumber - 1) / MIXTAPE_LETTERS.length) + 1;
  const letter = MIXTAPE_LETTERS[(sequenceNumber - 1) % MIXTAPE_LETTERS.length];

  return `${digit}${letter}`;
}

export function mixtapeLogId(recordedAt: string, sequenceNumber: number): string {
  return `${sector(recordedAt)}.F.${mixtapeTail(sequenceNumber)}`;
}
