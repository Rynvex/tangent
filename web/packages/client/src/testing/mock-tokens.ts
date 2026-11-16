/** About two characters per token for mixed Chinese and English. */
const CHARS_PER_TOKEN = 2;

/** The mock's token estimate (the server's is close enough for the interface). */
export const tokensOf = (text: string) => Math.ceil(Array.from(text).length / CHARS_PER_TOKEN);
