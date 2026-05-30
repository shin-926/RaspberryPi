import { env } from './env.ts';
import { getHenryIdToken } from './henry-auth.ts';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export type HenryEndpoint = '/graphql' | '/graphql-v2';

/**
 * Henry GraphQL を叩く共通ラッパ。ward-board-sync の query() を endpoint 切替対応に拡張。
 * /graphql と /graphql-v2 の両方を同じ ID トークンで叩ける。
 */
export async function query<T>(
  graphql: string,
  variables: Record<string, unknown> = {},
  endpoint: HenryEndpoint = '/graphql',
): Promise<T> {
  const idToken = await getHenryIdToken();
  const url = endpoint === '/graphql-v2' ? env.henryGraphqlV2Endpoint : env.henryGraphqlEndpoint;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
      'x-auth-organization-uuid': env.henryOrgUuid,
    },
    body: JSON.stringify({ query: graphql, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Henry GraphQL HTTP ${res.status} (${endpoint}): ${text.slice(0, 300)}`);
  }
  const json = await res.json() as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(`Henry GraphQL errors (${endpoint}): ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) throw new Error(`Henry GraphQL returned no data (${endpoint})`);
  return json.data;
}
