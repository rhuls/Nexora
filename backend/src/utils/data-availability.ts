export const DATA_UNAVAILABLE = 'DATA UNAVAILABLE' as const;
export type DataUnavailable = typeof DATA_UNAVAILABLE;

export function orUnavailable<T>(value: T | null | undefined): T | DataUnavailable {
  return value === null || value === undefined ? DATA_UNAVAILABLE : value;
}
