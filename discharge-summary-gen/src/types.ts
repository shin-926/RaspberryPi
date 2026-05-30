// Henry エンティティ型（extension/types/entities.d.ts より移植・必要分のみ）

export interface HenryDate {
  year: number;
  month: number;
  day: number;
}

export interface HenryPatient {
  uuid: string;
  serialNumber: string;
  serialNumberPrefix?: string;
  fullName: string;
  fullNamePhonetic: string;
  detail?: {
    birthDate: HenryDate | null;
    sexType: string;
    postalCode?: string;
    addressLine_1?: string;
    phoneNumber?: string;
    memo?: string;
  };
}

export interface HenryHospitalization {
  uuid: string;
  state: string;
  startDate: HenryDate;
  endDate: HenryDate | null;
  hospitalizationDayCount?: { value: number };
  lastHospitalizationLocation?: {
    ward?: { name: string };
    room?: { name: string };
  };
  hospitalizationDoctor?: {
    doctor?: { name: string };
  };
}

export interface HenryDisease {
  uuid: string;
  patientUuid: string;
  startDate: HenryDate | null;
  endDate: HenryDate | null;
  outcome?: string;
  isMain: boolean;
  isSuspected?: boolean;
  excludeReceipt?: boolean;
  intractableDiseaseType?: string;
  patientCareType?: string;
  masterDisease?: { name: string; code: string } | null;
  masterModifiers?: Array<{ name: string; code: string; position: string }>;
  customDiseaseName?: { value: string } | null;
  isDraft?: boolean;
}

export interface HenryClinicalDocument {
  uuid: string;
  editorData: string;
  performTime?: { seconds: number };
  updateTime?: { seconds: number };
  creatorUuid?: string;
  creator?: { name: string };
  type?: {
    type: string;
    __typename?: string;
    clinicalDocumentCustomTypeUuid?: { value: string } | null;
  };
}

/** AI生成結果（henry_discharge_summary.ts の AiResult と同一） */
export interface AiResult {
  chiefComplaint: string;
  presentIllness: string;
  pastHistory: string;
  admissionFindings: string;
  progress: string;
  plan: string;
}
