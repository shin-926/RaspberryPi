// Kファイル（DPC様式K：匿名化症例情報）のパーサー
//
// フォーマット:
// - SHIFT-JISエンコード、CSV
// - 1行=1入院、患者識別情報を含む
//
// 列構造（FAQから推測）:
// 1.施設コード 2.データ識別番号 3.入院年月日 4.退院年月日 5.提出月
// 6.カナ氏名 7.性別(1/2) 8.生年月日 9.保険者番号 10.(空) 11.被保険者証記号番号 12.(空)
import { readFileSync } from 'node:fs';
import type { FF1Patient } from './ff1-parser.ts';

export interface KnRecord {
  facilityCode: string;
  dataIdentifier: string;
  admissionDate: string;       // YYYY-MM-DD
  dischargeDate: string;       // YYYY-MM-DD or ''
  submissionMonth: string;
  kanaName: string;
  sex: '男' | '女' | '不明';
  birthDate: string;           // YYYY-MM-DD
  insurerNumber: string;
  insuredId: string;
}

function decodeShiftJis(buf: Buffer): string {
  try {
    return new TextDecoder('shift_jis').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function parseDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8 || yyyymmdd === '00000000') return '';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export function parseKnFile(path: string): KnRecord[] {
  const buf = readFileSync(path);
  const text = decodeShiftJis(buf);
  const records: KnRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    if (cols.length < 11) continue;
    const sexCode = cols[6];
    records.push({
      facilityCode: cols[0],
      dataIdentifier: cols[1],
      admissionDate: parseDate(cols[2]),
      dischargeDate: parseDate(cols[3]),
      submissionMonth: cols[4],
      kanaName: cols[5],
      sex: sexCode === '1' ? '男' : sexCode === '2' ? '女' : '不明',
      birthDate: parseDate(cols[7]),
      insurerNumber: cols[8] || '',
      insuredId: cols[10] || '',
    });
  }
  return records;
}

/**
 * FF1患者 ↔ Kn記録のキー突合
 * キー: dataIdentifier + admissionDate
 * 戻り値: dataIdentifier → KnRecord のマップ
 */
export function indexKnByPatientKey(records: KnRecord[]): Map<string, KnRecord> {
  const map = new Map<string, KnRecord>();
  for (const r of records) {
    const key = `${r.dataIdentifier}_${r.admissionDate.replace(/-/g, '')}`;
    map.set(key, r);
  }
  return map;
}

/** FF1患者にKn情報（カナ・生年月日）を付与 */
export interface FF1PatientWithIdentity extends FF1Patient {
  kanaName: string;
}

export function attachIdentity(
  ff1Patients: FF1Patient[],
  knByKey: Map<string, KnRecord>,
): FF1PatientWithIdentity[] {
  return ff1Patients.map((p) => {
    const key = `${p.dataIdentifier}_${p.admissionDate.replace(/-/g, '')}`;
    const kn = knByKey.get(key);
    return {
      ...p,
      kanaName: kn?.kanaName || '',
    };
  });
}

// ============================================================
// 動作テスト用
// ============================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: kn-parser.ts <Kn.csv>');
    process.exit(2);
  }
  const records = parseKnFile(path);
  console.log(`Kn記録数: ${records.length}`);
  for (const r of records.slice(0, 5)) {
    console.log(`${r.dataIdentifier} | ${r.kanaName} | ${r.sex} | ${r.birthDate} | 入院 ${r.admissionDate} | 退院 ${r.dischargeDate}`);
  }
}
