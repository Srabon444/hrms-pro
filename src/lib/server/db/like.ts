export const likeEscape = (value: string): string => value.replaceAll('\0', '').replace(/[\\%_]/g, (c) => `\\${c}`);

export const containsPattern = (value: string): string => `%${likeEscape(value)}%`;
