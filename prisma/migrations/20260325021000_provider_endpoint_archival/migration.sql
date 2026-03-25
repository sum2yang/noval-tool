ALTER TABLE "ProviderEndpoint"
ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "ProviderEndpoint_userId_archivedAt_idx"
ON "ProviderEndpoint"("userId", "archivedAt");
