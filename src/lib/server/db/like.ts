export const likeEscape = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export const containsPattern = (value: string): string => `%${likeEscape(value)}%`;
