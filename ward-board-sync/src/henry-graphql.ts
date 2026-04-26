import { env } from './env.ts';
import { getHenryIdToken } from './henry-auth.ts';
import type { WardHospitalization } from './types.ts';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function query<T>(graphql: string, variables: Record<string, unknown> = {}): Promise<T> {
  const idToken = await getHenryIdToken();
  const res = await fetch(env.henryGraphqlEndpoint, {
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
    throw new Error(`Henry GraphQL HTTP ${res.status}: ${text}`);
  }
  const json = await res.json() as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(`Henry GraphQL errors: ${json.errors.map(e => e.message).join('; ')}`);
  }
  if (!json.data) throw new Error('Henry GraphQL returned no data');
  return json.data;
}

const ACTIVE_STATES = new Set(['ADMITTED', 'HOSPITALIZED', 'WILL_DISCHARGE']);

interface ListDailyWardHospitalizationsResponse {
  listDailyWardHospitalizations: {
    dailyWardHospitalizations: Array<{
      wardId: string;
      roomHospitalizationDistributions: Array<{
        roomId: string;
        hospitalizations: WardHospitalization[];
      }>;
    }>;
  };
}

export async function fetchAllHospitalizedPatients(): Promise<WardHospitalization[]> {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const d = today.getDate();

  const graphql = `
    query ListDailyWardHospitalizations {
      listDailyWardHospitalizations(input: {
        wardIds: [],
        searchDate: { year: ${y}, month: ${m}, day: ${d} },
        roomIds: [],
        searchText: ""
      }) {
        dailyWardHospitalizations {
          wardId
          roomHospitalizationDistributions {
            roomId
            hospitalizations {
              uuid
              state
              startDate { year month day }
              patient {
                uuid
                serialNumber
                fullName
                fullNamePhonetic
              }
              hospitalizationDoctor {
                doctor { name }
              }
              lastHospitalizationLocation {
                ward { name }
                room { name }
              }
              statusHospitalizationLocation {
                ward { name }
                room { name }
              }
            }
          }
        }
      }
    }
  `;

  const data = await query<ListDailyWardHospitalizationsResponse>(graphql);
  const wards = data.listDailyWardHospitalizations?.dailyWardHospitalizations || [];

  const patients: WardHospitalization[] = [];
  for (const ward of wards) {
    for (const room of ward.roomHospitalizationDistributions || []) {
      for (const h of room.hospitalizations || []) {
        if (ACTIVE_STATES.has(h.state)) patients.push(h);
      }
    }
  }
  return patients;
}
