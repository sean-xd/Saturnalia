const JOIN_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const JOIN_CODE_LENGTH = 4;

export function normalizeJoinCode(input: string): string {
  return input.trim().toUpperCase();
}

export function generateJoinCode(): string {
  let code = "";

  for (let index = 0; index < JOIN_CODE_LENGTH; index += 1) {
    const randomIndex = Math.floor(Math.random() * JOIN_CODE_ALPHABET.length);
    code += JOIN_CODE_ALPHABET[randomIndex];
  }

  return code;
}