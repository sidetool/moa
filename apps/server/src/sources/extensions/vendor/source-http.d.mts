export function isPublicSourceAddress(address: string): boolean;
export function approveSourceUrl(
  value: string,
  origins: readonly string[],
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>,
): Promise<{
  url: URL;
  address: { address: string; family: number };
  addresses: { address: string; family: number }[];
}>;
