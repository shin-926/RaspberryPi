// Phase A 検証: 実患者でデータ収集が一通り通るかを確認する。
// PII は出力しない（件数・有無・状態のみ）。
import {
  getPatient,
  getTargetHospitalization,
  fetchMainDisease,
  fetchClinicalRecords,
  fetchCalendarData,
} from './collect.ts';

const PATIENT_UUID = process.argv[2] || '89b640ba-264d-411d-9df5-8c03eff76cca';

async function main(): Promise<void> {
  console.log('[verify-collect] データ収集を実行します（PIIは表示しません）...');

  const [patient, hosp] = await Promise.all([
    getPatient(PATIENT_UUID),
    getTargetHospitalization(PATIENT_UUID),
  ]);

  if (!patient) throw new Error('getPatient が null');
  if (!hosp) throw new Error('getTargetHospitalization が null');

  const hospStartDate = new Date(hosp.startDate.year, (hosp.startDate.month || 1) - 1, hosp.startDate.day || 1);

  const [disease, records, calendar] = await Promise.all([
    fetchMainDisease(PATIENT_UUID),
    fetchClinicalRecords(PATIENT_UUID),
    fetchCalendarData(PATIENT_UUID, hospStartDate),
  ]);

  const activeRx = calendar.prescriptionOrders.filter((rx) => rx.orderStatus === 'ORDER_STATUS_ACTIVE');
  const dischargeRx = activeRx.filter((rx) => rx.medicationCategory === 'MEDICATION_CATEGORY_DISCHARGE');

  console.log('[verify-collect] OK。構造サマリー（値・氏名は非表示）:');
  console.log({
    patient: { hasName: !!patient.fullName, hasBirthDate: !!patient.detail?.birthDate, sexKnown: !!patient.detail?.sexType },
    hospitalization: { state: hosp.state, hasStart: !!hosp.startDate?.year, hasEnd: !!hosp.endDate?.year, dayCount: hosp.hospitalizationDayCount?.value ?? null },
    mainDiseaseRegistered: disease !== '未登録',
    records: {
      doctorRecords: records.doctorRecords.length,
      nursingRecords: records.nursingRecords.length,
      profilePresent: !!records.profile,
    },
    calendar: {
      vitalSigns: calendar.vitalSigns.length,
      prescriptionOrders: calendar.prescriptionOrders.length,
      activePrescriptions: activeRx.length,
      dischargePrescriptions: dischargeRx.length,
      injectionOrders: calendar.injectionOrders.length,
      labGroups: calendar.outsideInspectionReportGroups.length,
    },
  });
}

main().catch((e) => {
  console.error('[verify-collect] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
