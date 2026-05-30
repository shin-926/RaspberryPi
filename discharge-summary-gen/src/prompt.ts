// Phase B: AIプロンプト構築（henry_discharge_summary.ts の formatCalendarForPrompt / buildPromptMarkdown を移植）
import { cleanMedicineName, toIsoDate, formatHenryDate, calculateAge, genderText } from './collect.ts';
import type { CalendarData } from './collect.ts';
import type { HenryDate, HenryPatient, HenryHospitalization } from './types.ts';

export interface FormattedCalendar {
  prescriptions: string;
  dischargePrescriptions: string;
  injections: string;
  vitals: string;
  labResults: string;
}

/** カレンダーデータを読みやすいテキストに変換 */
export function formatCalendarForPrompt(calendarData: CalendarData): FormattedCalendar {
  let prescriptions = '';
  let dischargePrescriptions = '';
  let injections = '';
  let vitals = '';
  let labResults = '';

  const activeRx = calendarData.prescriptionOrders.filter(
    (rx: Record<string, unknown>) => rx.orderStatus === 'ORDER_STATUS_ACTIVE',
  );
  const dischargeRx = activeRx.filter(
    (rx: Record<string, unknown>) => rx.medicationCategory === 'MEDICATION_CATEGORY_DISCHARGE',
  );
  const nonDischargeRx = activeRx.filter(
    (rx: Record<string, unknown>) => rx.medicationCategory !== 'MEDICATION_CATEGORY_DISCHARGE',
  );

  function formatRxList(rxList: Array<Record<string, unknown>>): string {
    const meds: string[] = [];
    for (const rx of rxList) {
      const sd = rx.startDate as { year: number; month: number; day: number } | undefined;
      const startDateStr = sd ? `${sd.year}-${String(sd.month).padStart(2, '0')}-${String(sd.day).padStart(2, '0')}` : '';
      for (const rp of (rx.rps as Array<Record<string, unknown>>) || []) {
        const insts = (rp.instructions as Array<Record<string, unknown>>) || [];
        const drugEntries = insts.map((inst) => {
          const med = (inst.instruction as Record<string, unknown>)?.medicationDosageInstruction as Record<string, unknown> | undefined;
          const local = (med?.localMedicine as { name: string })?.name;
          const mhlw = (med?.mhlwMedicine as { name: string })?.name;
          const name = cleanMedicineName(local || mhlw || '');
          const dosePerDayRaw = ((med?.quantity as Record<string, unknown>)?.doseQuantityPerDay as { value: string })?.value;
          const dosePerDay = dosePerDayRaw ? parseInt(dosePerDayRaw) / 100000 : null;
          return { name, dosePerDay };
        }).filter((e) => e.name);

        if (drugEntries.length === 0) continue;

        const timingObj = (rp.medicationTiming as Record<string, unknown>)?.medicationTiming as Record<string, unknown> | undefined;
        const canonicalUsage = timingObj?.canonicalPrescriptionUsage as { text: string } | undefined;
        const usageText = (canonicalUsage?.text || '').replace(/，/g, ',');

        const asNeeded = rp.asNeeded as boolean;
        const days = (rp.boundsDurationDays as { value: string } | undefined)?.value;
        const daysNum = days ? parseInt(days) : null;

        const drugTexts = drugEntries.map((e) => {
          if (e.dosePerDay != null) {
            const doseStr = Number.isInteger(e.dosePerDay) ? String(e.dosePerDay) : String(e.dosePerDay);
            return `${e.name} ${doseStr}錠/日`;
          }
          return e.name;
        });

        const details: string[] = [];
        if (startDateStr) details.push(`${startDateStr}〜`);
        if (asNeeded) details.push('頓用');
        if (usageText) details.push(usageText);
        if (daysNum) details.push(`${daysNum}日分`);
        const detailStr = details.length > 0 ? `（${details.join('、')}）` : '';

        meds.push(`- ${drugTexts.join('、')}${detailStr}`);
      }
    }
    return [...new Set(meds)].join('\n');
  }

  prescriptions = formatRxList(nonDischargeRx);

  if (dischargeRx.length > 0) {
    const items: string[] = [];
    for (const rx of dischargeRx) {
      for (const rp of (rx.rps as Array<Record<string, unknown>>) || []) {
        const insts = (rp.instructions as Array<Record<string, unknown>>) || [];
        const drugEntries = insts.map((inst) => {
          const med = (inst.instruction as Record<string, unknown>)?.medicationDosageInstruction as Record<string, unknown> | undefined;
          const local = (med?.localMedicine as { name: string })?.name;
          const mhlw = (med?.mhlwMedicine as { name: string })?.name;
          const name = cleanMedicineName(local || mhlw || '');
          const dosePerDayRaw = ((med?.quantity as Record<string, unknown>)?.doseQuantityPerDay as { value: string })?.value;
          const dosePerDay = dosePerDayRaw ? parseInt(dosePerDayRaw) / 100000 : null;
          return { name, dosePerDay };
        }).filter((e) => e.name);
        if (drugEntries.length === 0) continue;

        const timingObj = (rp.medicationTiming as Record<string, unknown>)?.medicationTiming as Record<string, unknown> | undefined;
        const usageText = (timingObj?.canonicalPrescriptionUsage as { text: string })?.text?.replace(/，/g, ',') || '';
        const asNeeded = rp.asNeeded as boolean;

        const details: string[] = [];
        if (asNeeded) details.push('頓用');
        if (usageText) details.push(usageText);
        const detailStr = details.length > 0 ? ` ${details.join(' ')}` : '';

        for (const e of drugEntries) {
          let drugText = e.name;
          if (e.dosePerDay != null) {
            const doseStr = Number.isInteger(e.dosePerDay) ? String(e.dosePerDay) : String(e.dosePerDay);
            drugText += ` ${doseStr}錠/日`;
          }
          items.push(`・${drugText}${detailStr}`);
        }
      }
    }
    const lines: string[] = [];
    for (let i = 0; i < items.length; i += 2) {
      if (i + 1 < items.length) {
        lines.push(`${items[i]}\t${items[i + 1]}`);
      } else {
        lines.push(items[i]);
      }
    }
    dischargePrescriptions = lines.join('\n')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s: string) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
      .replace(/．/g, '.').replace(/，/g, ',');
  }

  const activeInj = calendarData.injectionOrders.filter(
    (inj: Record<string, unknown>) => inj.orderStatus !== 'ORDER_STATUS_CANCELLED',
  );
  if (activeInj.length > 0) {
    const items: string[] = [];
    for (const inj of activeInj) {
      const createSeconds = (inj.createTime as { seconds: number })?.seconds;
      const createDate = createSeconds ? toIsoDate(new Date(createSeconds * 1000)) : '';
      for (const rp of (inj.rps as Array<Record<string, unknown>>) || []) {
        const technique = ((rp.localInjectionTechnique as { name: string })?.name || '').replace(/，/g, ',');
        const names = ((rp.instructions as Array<Record<string, unknown>>) || []).map((inst) => {
          const med = (inst.instruction as Record<string, unknown>)?.medicationDosageInstruction as Record<string, unknown> | undefined;
          return cleanMedicineName((med?.localMedicine as { name: string })?.name || (med?.mhlwMedicine as { name: string })?.name || '');
        }).filter(Boolean);
        if (names.length > 0) items.push(`- ${technique ? technique + ': ' : ''}${names.join(', ')}（${createDate}）`);
      }
    }
    injections = items.join('\n');
  }

  // バイタル（直近5日分のサマリー）。Henry APIのバイタル値は全て10倍整数で返る。
  const vitalsByDate = new Map<string, Array<{ temp?: number; pulse?: number; bpHigh?: number; bpLow?: number; spo2?: number }>>();
  for (const vs of calendarData.vitalSigns) {
    const seconds = (vs.recordTime as { seconds: number })?.seconds;
    if (!seconds) continue;
    const date = toIsoDate(new Date(seconds * 1000));
    if (!vitalsByDate.has(date)) vitalsByDate.set(date, []);
    const toReal = (v: { value: number } | undefined) => (v?.value ? v.value / 10 : undefined);
    vitalsByDate.get(date)!.push({
      temp: toReal(vs.temperature as { value: number }),
      pulse: toReal(vs.pulseRate as { value: number }),
      bpHigh: toReal(vs.bloodPressureUpperBound as { value: number }),
      bpLow: toReal(vs.bloodPressureLowerBound as { value: number }),
      spo2: toReal(vs.spo2 as { value: number }),
    });
  }
  const sortedDates = [...vitalsByDate.keys()].sort().slice(-5);
  if (sortedDates.length > 0) {
    const vitalLines: string[] = [];
    for (const date of sortedDates) {
      const entries = vitalsByDate.get(date)!;
      const last = entries[entries.length - 1];
      const parts: string[] = [];
      if (last.temp) parts.push(`体温${last.temp}℃`);
      if (last.bpHigh && last.bpLow) parts.push(`血圧${last.bpHigh}/${last.bpLow}`);
      if (last.pulse) parts.push(`脈拍${last.pulse}`);
      if (last.spo2) parts.push(`SpO2 ${last.spo2}%`);
      if (parts.length > 0) vitalLines.push(`- ${date}: ${parts.join(', ')}`);
    }
    vitals = vitalLines.join('\n');
  }

  // 検査結果（異常値 + 直近値）
  const labLines: string[] = [];
  for (const group of calendarData.outsideInspectionReportGroups) {
    const groupName = (group as Record<string, unknown>).name as string;
    const rows = (group as Record<string, unknown>).outsideInspectionReportRows as Array<Record<string, unknown>> || [];
    const groupItems: string[] = [];
    for (const row of rows) {
      const rowName = row.name as string;
      const reports = (row.outsideInspectionReports as Array<Record<string, unknown>>) || [];
      if (reports.length === 0) continue;
      const latest = reports[reports.length - 1];
      const value = latest.value as string;
      const isAbnormal = latest.isAbnormal as boolean;
      const refValue = (row.standardValue as { value: string })?.value || '';
      const date = latest.date as HenryDate;
      const dateStr = formatHenryDate(date);
      const mark = isAbnormal ? '**' : '';
      groupItems.push(`  - ${rowName}: ${mark}${value}${mark}${refValue ? ` (基準: ${refValue})` : ''} [${dateStr}]`);
    }
    if (groupItems.length > 0) {
      labLines.push(`### ${groupName}`);
      labLines.push(groupItems.join('\n'));
    }
  }
  labResults = labLines.join('\n');

  return { prescriptions, dischargePrescriptions, injections, vitals, labResults };
}

export function buildPromptMarkdown(
  patient: HenryPatient,
  hosp: HenryHospitalization,
  disease: string,
  profile: string,
  doctorRecords: Array<{ date: string; text: string; author: string }>,
  nursingRecords: Array<{ date: string; text: string }>,
  calendar: FormattedCalendar,
): string {
  const lines: string[] = [];
  const age = calculateAge(patient.detail?.birthDate ?? null);
  const gender = genderText(patient.detail?.sexType || '');

  lines.push('# 入院患者カルテデータ\n');

  lines.push('## 基本情報');
  lines.push(`- 年齢・性別: ${age}歳 ${gender}`);
  lines.push(`- 主病名: ${disease}`);
  lines.push(`- 入院日: ${formatHenryDate(hosp.startDate)}`);
  if (hosp.endDate) lines.push(`- ${hosp.state === 'WILL_DISCHARGE' ? '退院予定日' : '退院日'}: ${formatHenryDate(hosp.endDate)}`);
  lines.push(`- 入院日数: ${hosp.hospitalizationDayCount?.value || '不明'}日`);
  lines.push(`- 病棟: ${hosp.lastHospitalizationLocation?.ward?.name || ''} ${hosp.lastHospitalizationLocation?.room?.name || ''}`);
  lines.push('');

  if (profile) {
    lines.push('## 既往歴・患者プロフィール');
    lines.push(profile);
    lines.push('');
  }

  if (doctorRecords.length > 0) {
    lines.push('## 医師記録');
    for (const r of doctorRecords) {
      lines.push(`### ${r.date}${r.author ? ` (${r.author})` : ''}`);
      lines.push(r.text);
      lines.push('');
    }
  }

  if (nursingRecords.length > 0) {
    lines.push('## 看護記録');
    for (const r of nursingRecords) {
      lines.push(`### ${r.date}`);
      lines.push(r.text);
      lines.push('');
    }
  }

  if (calendar) {
    if (calendar.prescriptions) {
      lines.push('## 入院中処方');
      lines.push(calendar.prescriptions);
      lines.push('');
    }
    if (calendar.dischargePrescriptions) {
      lines.push('## 退院時処方');
      lines.push(calendar.dischargePrescriptions);
      lines.push('');
    }
    if (calendar.injections) {
      lines.push('## 注射');
      lines.push(calendar.injections);
      lines.push('');
    }
    if (calendar.vitals) {
      lines.push('## バイタルサイン推移');
      lines.push(calendar.vitals);
      lines.push('');
    }
    if (calendar.labResults) {
      lines.push('## 検査結果');
      lines.push(calendar.labResults);
      lines.push('');
    }
  }

  return lines.join('\n');
}
