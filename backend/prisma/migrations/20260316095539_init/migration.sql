-- CreateTable
CREATE TABLE "MoodleSession" (
    "id" TEXT NOT NULL,
    "uniqueIdentity" TEXT NOT NULL,
    "nonUniqueId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "cookieString" TEXT NOT NULL,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoodleSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpiredNotification" (
    "id" TEXT NOT NULL,
    "uniqueIdentity" TEXT NOT NULL,
    "expiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpiredNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MoodleSession_uniqueIdentity_key" ON "MoodleSession"("uniqueIdentity");
