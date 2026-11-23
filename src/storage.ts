import * as admin from 'firebase-admin';
import dotenv from 'dotenv';
import { ProviderConnection, ProviderId, UserData } from './types';

dotenv.config();

if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (serviceAccount) {
    let credentials;
    try {
      credentials = JSON.parse(serviceAccount);
    } catch (e) {
      try {
        credentials = JSON.parse(Buffer.from(serviceAccount, 'base64').toString('utf-8'));
      } catch (e2) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT must be a valid JSON string or Base64 encoded JSON.');
      }
    }
    admin.initializeApp({
      credential: admin.credential.cert(credentials),
      projectId: projectId || credentials.project_id,
    });
  } else if (serviceAccountPath) {
    admin.initializeApp({
      credential: admin.credential.cert(require(serviceAccountPath)),
      projectId,
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
    });
  }
}

const db = admin.firestore();
const USERS_COLLECTION = 'users';

const stripUndefined = <T extends Record<string, any>>(obj: T): Partial<T> => {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned as Partial<T>;
};

export const saveUser = async (uid: string, data: Omit<UserData, 'uid'>) => {
  await db.collection(USERS_COLLECTION).doc(uid).set(stripUndefined(data), { merge: true });
};

export const saveProviderConnection = async (
  uid: string,
  provider: ProviderId,
  connection: ProviderConnection,
  displayName?: string
) => {
  const payload: Record<string, any> = {
    providers: {
      [provider]: stripUndefined(connection),
    },
  };
  if (displayName) {
    payload.displayName = displayName;
  }
  if (provider === 'spotify') {
    payload.spotifyId = connection.providerUserId;
  }
  await db.collection(USERS_COLLECTION).doc(uid).set(payload, { merge: true });
};

export const updateProviderConnection = async (
  uid: string,
  provider: ProviderId,
  partial: Partial<ProviderConnection>
) => {
  const cleaned = stripUndefined(partial);
  if (Object.keys(cleaned).length === 0) return;

  await db.collection(USERS_COLLECTION).doc(uid).set(
    {
      providers: {
        [provider]: cleaned,
      },
    },
    { merge: true }
  );
};

export const disconnectProvider = async (uid: string, provider: ProviderId) => {
  const docRef = db.collection(USERS_COLLECTION).doc(uid);
  const updates: Record<string, any> = {
    [`providers.${provider}`]: admin.firestore.FieldValue.delete(),
  };

  // Also clear legacy top-level fields if they belonged to this provider
  const user = await getUser(uid);
  if (user && (user.provider === provider || (!user.provider && provider === 'spotify'))) {
    updates.provider = admin.firestore.FieldValue.delete();
    updates.providerUserId = admin.firestore.FieldValue.delete();
    updates.accessToken = admin.firestore.FieldValue.delete();
    updates.refreshToken = admin.firestore.FieldValue.delete();
    updates.expiresAt = admin.firestore.FieldValue.delete();
    updates.clientId = admin.firestore.FieldValue.delete();
    updates.clientSecret = admin.firestore.FieldValue.delete();
    updates.lastPlayed = admin.firestore.FieldValue.delete();
    if (provider === 'spotify') {
      updates.spotifyId = admin.firestore.FieldValue.delete();
    }
  }

  await docRef.update(updates);
};

export const getUser = async (uid: string): Promise<UserData | null> => {
  const doc = await db.collection(USERS_COLLECTION).doc(uid).get();
  if (doc.exists) {
    const data = doc.data() as Omit<UserData, 'uid'>;
    return { uid, ...data };
  }
  return null;
};

export const getUserBySpotifyId = async (spotifyId: string): Promise<UserData | null> => {
  const querySnapshot = await db.collection(USERS_COLLECTION).where('spotifyId', '==', spotifyId).limit(1).get();
  if (!querySnapshot.empty) {
    const doc = querySnapshot.docs[0];
    const data = doc.data() as Omit<UserData, 'uid'>;
    return { uid: doc.id, ...data };
  }
  return null;
};

export const getUserByProviderId = async (provider: ProviderId, providerUserId: string): Promise<UserData | null> => {
  const nestedSnap = await db
    .collection(USERS_COLLECTION)
    .where(`providers.${provider}.providerUserId`, '==', providerUserId)
    .limit(1)
    .get();

  if (!nestedSnap.empty) {
    const doc = nestedSnap.docs[0];
    const data = doc.data() as Omit<UserData, 'uid'>;
    return { uid: doc.id, ...data };
  }

  const legacySnap = await db
    .collection(USERS_COLLECTION)
    .where('provider', '==', provider)
    .where('providerUserId', '==', providerUserId)
    .limit(1)
    .get();

  if (!legacySnap.empty) {
    const doc = legacySnap.docs[0];
    const data = doc.data() as Omit<UserData, 'uid'>;
    return { uid: doc.id, ...data };
  }

  if (provider === 'spotify') {
    return getUserBySpotifyId(providerUserId);
  }

  return null;
};

export const deleteUser = async (uid: string) => {
  await db.collection(USERS_COLLECTION).doc(uid).delete();
};
