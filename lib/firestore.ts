import { Firestore, AggregateField } from "@google-cloud/firestore";

const db = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

const COLLECTION = process.env.FIRESTORE_COLLECTION || "files";
const filesCollection = db.collection(COLLECTION);

export interface FirestoreStats {
  totalDone: number;
  totalBytes: number;
}

// Server-side aggregation — cheap at any scale, never reads full documents
// into the app just to count/sum them.
export async function getFirestoreStats(): Promise<FirestoreStats> {
  const snap = await filesCollection
    .where("status", "==", "done")
    .aggregate({ totalDone: AggregateField.count(), totalBytes: AggregateField.sum("size_bytes") })
    .get();
  const data = snap.data();
  return { totalDone: data.totalDone, totalBytes: data.totalBytes ?? 0 };
}

export { db, filesCollection };
