// 連絡表用の純粋抽出関数群
// 元実装: ~/Projects/Henry/extension/scripts/karte/timeline/data-extract.ts
// HTML依存部分(escapeHtml, vital-high span 等)は除き、構造化データのみ返すように調整
//
// すべて入力データから派生する純粋関数。GraphQLは触らない。
import type { CQDModuleCollection, NutritionOrder, InjectionOrder, OxygenEntry } from './renraku-types.ts';

// ============================================================
// 酸素データ抽出 → 連絡表Ⅱ呼吸不全のFiO2/酸素投与/呼吸補助
// ============================================================
export function extractOxygenData(
  moduleCollections: CQDModuleCollection[],
): Map<string, OxygenEntry[]> {
  const byDate = new Map<string, OxygenEntry[]>();

  for (const collection of moduleCollections) {
    for (const mod of collection?.clinicalQuantitativeDataModules || []) {
      const dateRange = mod.recordDateRange;
      if (!dateRange?.start) continue;
      const { year, month, day } = dateRange.start;
      const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      if (!byDate.has(key)) byDate.set(key, []);

      let flow: string | null = null;
      let method: string | null = null;
      let time = 0;
      for (const entry of mod.entries || []) {
        const name = entry.name || '';
        if (name.includes('酸素投与量')) flow = entry.value;
        else if (name.includes('酸素投与方法')) method = entry.value;
        else if (name.includes('酸素変更時刻')) {
          const m = (entry.value || '').match(/(\d{1,2}):(\d{2})/);
          if (m) time = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        }
      }
      if (flow !== null) byDate.get(key)!.push({ time, flow, method });
    }
  }

  // 時刻順 → 重複dedup
  for (const [key, entries] of byDate) {
    entries.sort((a, b) => a.time - b.time);
    byDate.set(
      key,
      entries.filter((e, i) => i === 0 || e.flow !== entries[i - 1].flow || e.method !== entries[i - 1].method),
    );
  }
  return byDate;
}

// ============================================================
// 食事摂取量抽出
// ============================================================
export interface MealEntry {
  date: string;
  dietType: string | null;
  meal: {
    breakfast: { main: number | null; side: number | null };
    lunch: { main: number | null; side: number | null };
    dinner: { main: number | null; side: number | null };
  };
}

export function extractMealIntake(
  moduleCollections: CQDModuleCollection[],
  nutritionOrders: NutritionOrder[],
): MealEntry[] {
  const byDate = new Map<string, MealEntry>();
  const mealPatterns = ['朝食(主)', '朝食(副)', '昼食(主)', '昼食(副)', '夕食(主)', '夕食(副)'];

  for (const collection of moduleCollections) {
    for (const mod of collection?.clinicalQuantitativeDataModules || []) {
      const dateRange = mod.recordDateRange;
      if (!dateRange?.start) continue;
      const { year, month, day } = dateRange.start;
      const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      if (!byDate.has(key)) {
        byDate.set(key, {
          date: key,
          dietType: null,
          meal: {
            breakfast: { main: null, side: null },
            lunch: { main: null, side: null },
            dinner: { main: null, side: null },
          },
        });
      }
      const day_ = byDate.get(key)!;

      for (const entry of mod.entries || []) {
        const name = entry.name || '';
        const v = entry.value != null ? parseInt(entry.value, 10) : null;
        if (!mealPatterns.some((p) => name.includes(p))) continue;
        if (v == null || isNaN(v)) continue;

        if (name.includes('朝食(主)')) day_.meal.breakfast.main = v;
        else if (name.includes('朝食(副)')) day_.meal.breakfast.side = v;
        else if (name.includes('昼食(主)')) day_.meal.lunch.main = v;
        else if (name.includes('昼食(副)')) day_.meal.lunch.side = v;
        else if (name.includes('夕食(主)')) day_.meal.dinner.main = v;
        else if (name.includes('夕食(副)')) day_.meal.dinner.side = v;
      }
    }
  }

  // 食種情報を付与
  for (const e of byDate.values()) {
    const date = new Date(e.date);
    e.dietType = getNutritionInfoForDate(date, nutritionOrders)?.name ?? null;
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// 栄養オーダー：指定日に有効なものを取得
// ============================================================
export function getNutritionInfoForDate(
  date: Date,
  nutritionOrders: NutritionOrder[],
): { name: string | null; supplies: NonNullable<NonNullable<NutritionOrder['detail']>['supplies']> } | null {
  for (const order of nutritionOrders) {
    if (order.isDraft) continue;
    if (!order.startDate) continue;
    const start = new Date(order.startDate.year, order.startDate.month - 1, order.startDate.day);
    const end = order.endDate
      ? new Date(order.endDate.year, order.endDate.month - 1, order.endDate.day)
      : new Date(9999, 11, 31);
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    if (d >= start && d <= end) {
      return {
        name: order.detail?.dietaryRegimen?.name || order.detail?.supplies?.[0]?.food?.name || null,
        supplies: order.detail?.supplies || [],
      };
    }
  }
  return null;
}

// ============================================================
// 尿量抽出
// ============================================================
export function extractUrineByDate(
  moduleCollections: CQDModuleCollection[],
): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const collection of moduleCollections) {
    for (const mod of collection?.clinicalQuantitativeDataModules || []) {
      const dateRange = mod.recordDateRange;
      if (!dateRange?.start) continue;
      const { year, month, day } = dateRange.start;
      const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      for (const entry of mod.entries || []) {
        if ((entry.name || '').includes('合計尿量') && entry.value != null) {
          const v = parseInt(entry.value, 10);
          if (!isNaN(v) && !byDate.has(key)) byDate.set(key, v);
        }
      }
    }
  }
  return byDate;
}

// ============================================================
// 院内検査抽出（マオカ専用UUID）
// ============================================================
const INHOUSE_BLOOD_TEST_UUID = '614e72ad-78ed-4aba-98a9-25d87efcf846';

export interface InHouseBloodTestEntry {
  name: string;
  value: string;
  unit: string;
}
export interface InHouseBloodTestModule {
  dateKey: string;
  entries: InHouseBloodTestEntry[];
}

export function extractInHouseBloodTests(
  moduleCollections: CQDModuleCollection[],
): InHouseBloodTestModule[] {
  const result: InHouseBloodTestModule[] = [];
  for (const collection of moduleCollections) {
    const hrn = collection?.cqdDefHrn || '';
    if (!hrn.includes(INHOUSE_BLOOD_TEST_UUID)) continue;
    for (const mod of collection?.clinicalQuantitativeDataModules || []) {
      const dateRange = mod.recordDateRange?.start;
      if (!dateRange) continue;
      const dateKey = `${dateRange.year}-${String(dateRange.month).padStart(2, '0')}-${String(dateRange.day).padStart(2, '0')}`;
      const entries = (mod.entries || []).map((e) => ({
        name: e.name,
        value: e.value || '',
        unit: e.unit?.value || '',
      }));
      result.push({ dateKey, entries });
    }
  }
  return result;
}

// ============================================================
// 検査値の基準値パース・L/H判定（連絡表Ⅱの閾値判定に使用）
// ============================================================
export function parseReferenceValue(refValue: string): { low: number | null; high: number | null } | null {
  if (!refValue) return null;
  const rangeMatch = refValue.match(/([0-9.]+)\s*[-～~]\s*([0-9.]+)/);
  if (rangeMatch) return { low: parseFloat(rangeMatch[1]), high: parseFloat(rangeMatch[2]) };

  const upperMatch =
    refValue.match(/([0-9.]+)\s*以下/) ||
    refValue.match(/≦\s*([0-9.]+)/) ||
    refValue.match(/<=\s*([0-9.]+)/);
  if (upperMatch) return { low: null, high: parseFloat(upperMatch[1]) };

  const lowerMatch =
    refValue.match(/([0-9.]+)\s*以上/) ||
    refValue.match(/≧\s*([0-9.]+)/) ||
    refValue.match(/>=\s*([0-9.]+)/);
  if (lowerMatch) return { low: parseFloat(lowerMatch[1]), high: null };

  return null;
}

export function judgeAbnormality(value: string, refValue: string): { isAbnormal: boolean; type: 'NORMAL' | 'LOW' | 'HIGH' } {
  const numValue = parseFloat(value);
  if (isNaN(numValue)) return { isAbnormal: false, type: 'NORMAL' };
  const range = parseReferenceValue(refValue);
  if (!range) return { isAbnormal: false, type: 'NORMAL' };
  if (range.low !== null && numValue < range.low) return { isAbnormal: true, type: 'LOW' };
  if (range.high !== null && numValue > range.high) return { isAbnormal: true, type: 'HIGH' };
  return { isAbnormal: false, type: 'NORMAL' };
}

// ============================================================
// 注射オーダー → 投与経路の判定（栄養経路5桁に使用）
// ============================================================
export interface InjectionRoute {
  isCentralVenous: boolean;   // 中心静脈栄養 (CV/TPN)
  isPeripheralVenous: boolean; // 末梢静脈栄養
  isSubcutaneous: boolean;     // 皮下注射
  isNutritionMedicine: boolean; // 栄養剤判定（アミノ酸/糖質/脂肪乳剤等）
}

/**
 * 指定日時点でアクティブな注射オーダーから、投与経路の有無を返す
 * 経路判定は `localInjectionTechnique.name` の文字列ベース
 */
export function classifyInjectionRoute(
  date: Date,
  injectionOrders: InjectionOrder[],
): InjectionRoute {
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);

  let cv = false, pv = false, sc = false, nutrition = false;

  for (const order of injectionOrders) {
    if (order.orderStatus !== 'ORDER_STATUS_ACTIVE') continue;
    // 期間判定：startDate + boundsDurationDays
    if (order.startDate) {
      const start = new Date(order.startDate.year, order.startDate.month - 1, order.startDate.day);
      start.setHours(0, 0, 0, 0);
      if (start > target) continue;

      let endDate: Date | null = null;
      for (const rp of order.rps || []) {
        const days = rp.boundsDurationDays?.value;
        if (days) {
          endDate = new Date(start);
          endDate.setDate(endDate.getDate() + days);
        }
      }
      if (endDate && endDate < target) continue;
    }

    for (const rp of order.rps || []) {
      const technique = rp.localInjectionTechnique?.name || '';
      if (technique.includes('中心静脈') || technique.includes('CV')) cv = true;
      if (technique.includes('末梢') && !technique.includes('中心')) pv = true;
      if (technique.includes('皮下')) sc = true;

      // 栄養剤判定：薬剤名にアミノ酸/糖質/脂肪乳剤などのキーワード
      for (const inst of rp.instructions || []) {
        const med = inst.instruction?.medicationDosageInstruction;
        const name = med?.localMedicine?.name || med?.mhlwMedicine?.name || '';
        if (
          /アミノ酸|アミノパレン|アミノフリード|ハイカリック|エルネオパ|フルカリック|ピーエヌツイン|脂肪乳剤|イントラリポス|エネフリード|ビーフリード|ソルデム|ソリタT|ラクテック|生食|生理食塩液|ブドウ糖/.test(
            name,
          )
        ) {
          // 注：「生食」「ソルデム」等は単なる維持輸液で栄養目的ではないことが多い
          // 厳密判定はTODO（マオカ実例で精緻化）
          if (/アミノ|ハイカリック|エルネオパ|フルカリック|ピーエヌツイン|脂肪乳剤|イントラリポス|エネフリード|ビーフリード/.test(name)) {
            nutrition = true;
          }
        }
      }
    }
  }
  return { isCentralVenous: cv, isPeripheralVenous: pv, isSubcutaneous: sc, isNutritionMedicine: nutrition };
}

// ============================================================
// 栄養オーダー → 経腸経路の判定（経鼻胃管/胃瘻腸瘻）
// ============================================================
export interface EnteralRoute {
  isNGTube: boolean;    // 経鼻胃管
  isGastrostomy: boolean; // 胃瘻・腸瘻
  isOral: boolean;      // 経口（通常食 / ソフト食 / トロミ等）
  isFasting: boolean;   // 絶食
}

/**
 * 指定日時点で有効な栄養オーダーから経腸経路を判定する。
 * dietaryRegimen.name と supplies[].food.name の文字列で識別。
 */
export function classifyEnteralRoute(date: Date, nutritionOrders: NutritionOrder[]): EnteralRoute {
  const info = getNutritionInfoForDate(date, nutritionOrders);
  if (!info?.name) return { isNGTube: false, isGastrostomy: false, isOral: false, isFasting: false };

  const name = info.name;
  const supplyNames = (info.supplies || []).map((s) => s.food?.name || '').join(' ');

  const isFasting = name === '絶食' || name.includes('絶食');
  // 「経管栄養」「経鼻」「経腸」をキーワードに識別
  const isNGTube = /経鼻|NG/.test(name + supplyNames);
  const isGastrostomy = /胃瘻|腸瘻|PEG/.test(name + supplyNames);
  // それ以外で「絶食」でないなら経口食
  const isOral = !isFasting && !isNGTube && !isGastrostomy;

  return { isNGTube, isGastrostomy, isOral, isFasting };
}
