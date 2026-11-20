CREATE TABLE "passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialID" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "transports" TEXT,
    "createdAt" TIMESTAMP(3),
    "aaguid" TEXT,

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "passkey_credentialID_key" ON "passkey"("credentialID");
CREATE INDEX "passkey_userId_idx" ON "passkey"("userId");

ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
