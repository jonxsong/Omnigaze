import { eraseOwnerSavedData } from "@/lib/repositories/account-data";

type AccountDataDeletionDependencies = {
  eraseOwnerSavedData(ownerId: string): Promise<void>;
};

const defaultDependencies: AccountDataDeletionDependencies = {
  eraseOwnerSavedData,
};

export async function deleteSavedAccountData(
  ownerId: string,
  dependencies: AccountDataDeletionDependencies = defaultDependencies,
) {
  await dependencies.eraseOwnerSavedData(ownerId);
  return { deleted: true as const };
}

