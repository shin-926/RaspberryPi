import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { env } from './env.ts';
import type { WardHospitalization, DateYMD, SyncResult } from './types.ts';

let _db: Firestore | null = null;

function db(): Firestore {
  if (_db) return _db;
  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
      projectId: env.firebaseProjectId,
    });
  }
  _db = getFirestore();
  return _db;
}

function formatDate(d: DateYMD | null): string {
  if (!d) return '';
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function getWardName(h: WardHospitalization): string {
  return h.statusHospitalizationLocation?.ward?.name || h.lastHospitalizationLocation?.ward?.name || '';
}

function getRoomName(h: WardHospitalization): string {
  return h.statusHospitalizationLocation?.room?.name || h.lastHospitalizationLocation?.room?.name || '';
}

const SYNC_FIELDS = [
  'patientName', 'patientNamePhonetic', 'ward', 'room',
  'admissionDate', 'attendingDoctor', 'hospitalizationState',
  'serialNumber', 'syncedAt', 'archived',
] as const;

const SYNCED_BY = 'ward-board-sync (raspberrypi)';

export async function syncWardPatients(hospitalizations: WardHospitalization[]): Promise<SyncResult> {
  const firestore = db();
  const collection = firestore.collection('wardPatients');
  const now = Timestamp.now();
  const nowMillis = Date.now();

  const snapshot = await collection.get();
  const existingByUuid = new Map<string, { docId: string; archived: boolean }>();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const uuid = data.patientUuid as string | undefined;
    if (uuid) {
      existingByUuid.set(uuid, { docId: doc.id, archived: data.archived === true });
    }
  }

  const seenUuids = new Set<string>();
  let added = 0, updated = 0, archived = 0;

  for (const h of hospitalizations) {
    const uuid = h.patient.uuid;
    seenUuids.add(uuid);
    const existing = existingByUuid.get(uuid);

    const baseFields = {
      patientUuid: uuid,
      patientName: h.patient.fullName,
      patientNamePhonetic: h.patient.fullNamePhonetic,
      ward: getWardName(h),
      room: getRoomName(h),
      admissionDate: formatDate(h.startDate),
      attendingDoctor: h.hospitalizationDoctor?.doctor?.name || '',
      hospitalizationState: h.state,
      serialNumber: h.patient.serialNumber || '',
      syncedAt: now,
      archived: false,
    };

    if (existing) {
      const updateFields: Record<string, unknown> = {};
      for (const f of SYNC_FIELDS) updateFields[f] = (baseFields as Record<string, unknown>)[f];
      await collection.doc(existing.docId).update(updateFields);
      updated++;
    } else {
      const newDocId = `${uuid.slice(0, 8)}-${nowMillis.toString(36)}`;
      await collection.doc(newDocId).set({
        ...baseFields,
        doctor: {},
        nurse: {},
        msw: {},
        rehab: {},
        nutrition: {},
        updatedAt: now,
        updatedBy: SYNCED_BY,
      });
      added++;
    }
  }

  for (const [uuid, { docId, archived: alreadyArchived }] of existingByUuid) {
    if (!seenUuids.has(uuid) && !alreadyArchived) {
      await collection.doc(docId).update({
        archived: true,
        archivedAt: now,
      });
      archived++;
    }
  }

  return { added, updated, archived, total: hospitalizations.length };
}
