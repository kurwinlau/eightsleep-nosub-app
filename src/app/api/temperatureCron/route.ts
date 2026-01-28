import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type Token } from "~/server/eight/types";
import { setHeatingLevel, turnOnSide, turnOffSide } from "~/server/eight/eight";
import { getCurrentHeatingStatus } from "~/server/eight/user";

export const runtime = "nodejs";

function createDateWithTime(baseDate: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(':').map(Number);
  if (hours === undefined || minutes === undefined || isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time string: ${timeString}`);
  }
  const result = new Date(baseDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function isWithinTimeRange(current: Date, target: Date, rangeMinutes: number): boolean {
  const diffMs = Math.abs(current.getTime() - target.getTime());
  return diffMs <= rangeMinutes * 60 * 1000;
}

async function retryApiCall<T>(apiCall: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error("Retry failed");
}

interface SleepCycle {
  preHeatingTime: Date;
  bedTime: Date;
  midStageTime: Date;
  finalStageTime: Date;
  warmingTime: Date; // Added for wake-up heat spike
  wakeupTime: Date;
}

function createSleepCycle(baseDate: Date, bedTimeStr: string, wakeupTimeStr: string): SleepCycle {
  const preHeatingTime = createDateWithTime(baseDate, bedTimeStr);
  preHeatingTime.setHours(preHeatingTime.getHours() - 1); 
  
  const bedTime = createDateWithTime(baseDate, bedTimeStr);
  let wakeupTime = createDateWithTime(baseDate, wakeupTimeStr);
  
  if (wakeupTime <= bedTime) {
    wakeupTime = addDays(wakeupTime, 1);
  }
  
  const midStageTime = new Date(bedTime.getTime() + 60 * 60 * 1000);
  const finalStageTime = new Date(wakeupTime.getTime() - 2 * 60 * 60 * 1000);
  const warmingTime = new Date(wakeupTime.getTime() - 30 * 60 * 1000); // 30 mins before alarm
  
  return { preHeatingTime, bedTime, midStageTime, finalStageTime, warmingTime, wakeupTime };
}

function adjustTimeToCurrentCycle(cycleStart: Date, currentTime: Date, timeInCycle: Date): Date {
  let adjustedTime = new Date(timeInCycle);
  if (timeInCycle < cycleStart) {
    adjustedTime = addDays(adjustedTime, 1);
  }
  if (adjustedTime > currentTime && adjustedTime.getTime() - currentTime.getTime() > 12 * 60 * 60 * 1000) {
    adjustedTime = addDays(adjustedTime, -1);
  }
  return adjustedTime;
}

interface TestMode {
  enabled: boolean;
  currentTime: Date;
}

export async function adjustTemperature(testMode?: TestMode): Promise<void> {
  try {
    const profiles = await db
      .select()
      .from(userTemperatureProfile)
      .innerJoin(users, eq(userTemperatureProfile.email, users.email));

    for (const profile of profiles) {
      try {
        let token: Token = {
          eightAccessToken: profile.users.eightAccessToken,
          eightRefreshToken: profile.users.eightRefreshToken,
          eightExpiresAtPosix: profile.users.eightTokenExpiresAt.getTime(),
          eightUserId: profile.users.eightUserId,
        };

        const now = testMode?.enabled ? testMode.currentTime : new Date();

        if (!testMode?.enabled && now.getTime() > token.eightExpiresAtPosix) {
          token = await obtainFreshAccessToken(token.eightRefreshToken, token.eightUserId);
          await db
            .update(users)
            .set({
              eightAccessToken: token.eightAccessToken,
              eightRefreshToken: token.eightRefreshToken,
              eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
            })
            .where(eq(users.email, profile.users.email));
        }

        const userTempProfile = profile.userTemperatureProfiles;
        const userNow = new Date(now.toLocaleString("en-US", { timeZone: userTempProfile.timezoneTZ }));

        const sleepCycle = createSleepCycle(userNow, userTempProfile.bedTime, userTempProfile.wakeupTime);

        const cycleStart = sleepCycle.preHeatingTime;
        const adjustedCycle: SleepCycle = {
          preHeatingTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.preHeatingTime),
          bedTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.bedTime),
          midStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.midStageTime),
          finalStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.finalStageTime),
          warmingTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.warmingTime),
          wakeupTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.wakeupTime),
        };

        let heatingStatus;
        if (testMode?.enabled) {
          heatingStatus = { isHeating: false, heatingLevel: 0 };
        } else {
          heatingStatus = await retryApiCall(() => getCurrentHeatingStatus(token));
        }

        const isNearPreHeating = isWithinTimeRange(userNow, adjustedCycle.preHeatingTime, 15);
        const isNearBedTime = isWithinTimeRange(userNow, adjustedCycle.bedTime, 15);
        const isNearMidStage = isWithinTimeRange(userNow, adjustedCycle.midStageTime, 15);
        const isNearFinalStage = isWithinTimeRange(userNow, adjustedCycle.finalStageTime, 15);
        const isNearWarming = isWithinTimeRange(userNow, adjustedCycle.warmingTime, 15);
        const isNearWakeup = isWithinTimeRange(userNow, adjustedCycle.wakeupTime, 15);

        let currentSleepStage = "outside sleep cycle";
        if (userNow >= adjustedCycle.preHeatingTime && userNow < adjustedCycle.bedTime) {
          currentSleepStage = "pre-heating";
        } else if (userNow >= adjustedCycle.bedTime && userNow < adjustedCycle.midStageTime) {
          currentSleepStage = "initial";
        } else if (userNow >= adjustedCycle.midStageTime && userNow < adjustedCycle.finalStageTime) {
          currentSleepStage = "mid";
        } else if (userNow >= adjustedCycle.finalStageTime && userNow < adjustedCycle.warmingTime) {
          currentSleepStage = "final";
        } else if (userNow >= adjustedCycle.warmingTime && userNow < adjustedCycle.wakeupTime) {
          currentSleepStage = "warming";
        }

        console.log(`User: ${profile.users.email} | Stage: ${currentSleepStage}`);

        if (isNearPreHeating || isNearBedTime || isNearMidStage || isNearFinalStage || isNearWarming || isNearWakeup) {
          let targetLevel: number;
          let sleepStage: string;

          if (isNearWarming) {
            targetLevel = 2; 
            sleepStage = "warming-alarm";
          } else if (isNearPreHeating || (isNearBedTime && userNow < adjustedCycle.bedTime)) {
            targetLevel = userTempProfile.initialSleepLevel;
            sleepStage = "pre-heating";
          } else if (isNearBedTime || (isNearMidStage && userNow < adjustedCycle.midStageTime)) {
            targetLevel = userTempProfile.initialSleepLevel;
            sleepStage = "initial";
          } else if (isNearMidStage || (isNearFinalStage && userNow < adjustedCycle.finalStageTime)) {
            targetLevel = userTempProfile.midStageSleepLevel;
            sleepStage = "mid";
          } else {
            targetLevel = userTempProfile.finalSleepLevel;
            sleepStage = "final";
          }

          if (!heatingStatus.isHeating) {
            if (!testMode?.enabled) await retryApiCall(() => turnOnSide(token, profile.users.eightUserId));
          }
          if (heatingStatus.heatingLevel !== targetLevel) {
            if (!testMode?.enabled) await retryApiCall(() => setHeatingLevel(token, profile.users.eightUserId, targetLevel));
          }
          console.log(`Adjusted to ${targetLevel} for ${sleepStage}`);
        } else if (heatingStatus.isHeating && userNow > adjustedCycle.wakeupTime && !isNearWakeup) {
          if (!testMode?.enabled) await retryApiCall(() => turnOffSide(token, profile.users.eightUserId));
          console.log(`Heating turned off`);
        }
      } catch (error) {
        console.error(`Error:`, error);
      }
    }
  } catch (error) {
    console.error("Critical error:", error);
    throw error;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const testTimeParam = request.nextUrl.searchParams.get("testTime");
    if (testTimeParam) {
      const testTime = new Date(Number(testTimeParam) * 1000);
      await adjustTemperature({ enabled: true, currentTime: testTime });
    } else {
      await adjustTemperature();
    }
    return Response.json({ success: true });
  } catch (error) {
    return new Response("Internal server error", { status: 500 });
  }
}
