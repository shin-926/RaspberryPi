export interface DateYMD {
  year: number;
  month: number;
  day: number;
}

export interface WardHospitalization {
  uuid: string;
  state: string;
  startDate: DateYMD | null;
  patient: {
    uuid: string;
    serialNumber: string;
    fullName: string;
    fullNamePhonetic: string;
  };
  hospitalizationDoctor: {
    doctor: { name: string };
  };
  lastHospitalizationLocation: {
    ward: { name: string };
    room: { name: string };
  };
  statusHospitalizationLocation: {
    ward: { name: string };
    room: { name: string };
  } | null;
}

export interface SyncResult {
  added: number;
  updated: number;
  archived: number;
  total: number;
}
