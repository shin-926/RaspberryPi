// Smoke test: verify Henry token refresh + GraphQL works
import { fetchAllHospitalizedPatients } from './henry-graphql.ts';

const patients = await fetchAllHospitalizedPatients();
console.log(`OK: Fetched ${patients.length} patient(s) from Henry`);
for (const p of patients.slice(0, 3)) {
  console.log(`  - ${p.patient.fullName} (${p.statusHospitalizationLocation?.ward?.name} ${p.statusHospitalizationLocation?.room?.name}) [${p.state}]`);
}
