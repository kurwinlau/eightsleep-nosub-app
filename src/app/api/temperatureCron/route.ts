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
  if (hours === undefined || minutes === undefined || isNaN(hours) || isNaN(minutes)) {
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
  warmingTime: Date; 
  wakeupTime: Date;
}

function createSleepCycle(baseDate: Date, bedTimeStr: string, wakeupTimeStr: string): SleepCycle {
  const preHeatingTime = createDateWithTime(baseDate, bedTimeStr);
  preHeatingTime.setHours(preHeatingTime.getHours() - 1); 
  const bedTime = createDateWithTime(baseDate, bedTimeStr);
  let wakeupTime = createDateWithTime(baseDate, wakeupTimeStr);
  if (wakeupTime <= bedTime) wakeupTime = addDays(wakeupTime, 1);
  
  const midStageTime = new Date(bedTime.getTime() + 60 * 60 * 1000);
  const finalStageTime = new Date(wakeupTime.getTime() - 120 * 60 * 1000); // 2 hours before
  const warmingTime = new Date(wakeupTime.getTime() - 30 * 60 * 1000); // 30 mins before
  
  return { preHeatingTime, bedTime, midStageTime, finalStageTime, warmingTime, wakeupTime };
}

function adjustTimeToCurrentCycle(cycleStart: Date, currentTime: Date, timeInCycle: Date): Date {
  let adjustedTime = new Date(timeInCycle);
  if (timeInCycle < cycleStart) adjustedTime = addDays(adjustedTime, 1);
  if (adjustedTime > currentTime && adjustedTime.getTime() - currentTime.getTime() > 12 * 60 * 60 * 1000) {
    adjustedTime = addDays(adjustedTime, -1);
  }
  return adjustedTime;
}

export async function adjustTemperature(testMode?: { enabled: boolean; currentTime: Date }): Promise<void> {
  try {
    const profiles = await db.select().from(userTemperatureProfile).innerJoin(users, eq(userTemperatureProfile.email, users.email));

    for (const profile of profiles) {
      try {
        let token: Token = {
          eightAccessToken: profile.users.eightAccessToken,
          eightRefreshToken: profile.users.eightRefreshToken,
          eightExpiresAtPosix: profile.users.eightTokenExpiresAt.getTime(),
          eightUserId: profile.users.eightUserId,
        };

        const now = testMode?.enabled ? testMode.currentTime : new Date();
        const userTemp = profile.userTemperatureProfiles;
        const userNow = new Date(now.toLocaleString("en-US", { timeZone: userTemp.timezoneTZ }));

        const sleepCycle = createSleepCycle(userNow, userTemp.bedTime, userTemp.wakeupTime);
        const cycleStart = sleepCycle.preHeatingTime;
        const adjustedCycle: SleepCycle = {
          preHeatingTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.preHeatingTime),
          bedTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.bedTime),
          midStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.midStageTime),
          finalStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.finalStageTime),
          warmingTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.warmingTime),
          wakeupTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.wakeupTime),
        };

        const isNearWarming = isWithinTimeRange(userNow, adjustedCycle.warmingTime, 15);
        const isNearFinal = isWithinTimeRange(userNow, adjustedCycle.finalStageTime, 15);
        const isNearWakeup = isWithinTimeRange(userNow, adjustedCycle.wakeupTime, 15);

        // REWRITTEN DETECTION LOGIC
        let currentSleepStage = "outside sleep cycle";
        if (userNow >= adjustedCycle.warmingTime && userNow < adjustedCycle.wakeupTime) {
          currentSleepStage = "warming";
        } else if (userNow >= adjustedCycle.finalStageTime && userNow < adjustedCycle.warmingTime) {
          currentSleepStage = "final";
        } else if (userNow >= adjustedCycle.midStageTime && userNow < adjustedCycle.finalStageTime) {
          currentSleepStage = "mid";
        } else if (userNow >= adjustedCycle.bedTime && userNow < adjustedCycle.midStageTime) {
          currentSleepStage = "initial";
        } else if (userNow >= adjustedCycle.preHeatingTime && userNow < adjustedCycle.bedTime) {
          currentSleepStage = "pre-heating";
        }

        console.log(`LOG: Time is ${userNow.toLocaleTimeString()} | Stage detected: ${currentSleepStage}`);

        if (isNearWarming || isNearWakeup || isNearFinal || isWithinTimeRange(userNow, adjustedCycle.midStageTime, 15) || isWithinTimeRange(userNow, adjustedCycle.bedTime, 15) || isWithinTimeRange(userNow, adjustedCycle.preHeatingTime, 15)) {
          let targetLevel = userTemp.midStageSleepLevel;
          let stageName = currentSleepStage;

          // PRIORITY ASSIGNMENT
          if (isNearWarming || currentSleepStage === "warming") {
            targetLevel = 10;
            stageName = "WARMING-SPIKE";
          } else if (currentSleepStage === "final") {
            targetLevel = userTemp.finalSleepLevel;
          } else if (currentSleepStage === "initial" || currentSleepStage === "pre-heating") {
            targetLevel = userTemp.initialSleepLevel;
          }

          console.log(`ACTION: Setting bed to ${targetLevel} for ${stageName}`);
          
          if (!testMode?.enabled) {
            const status = await retryApiCall(() => getCurrentHeatingStatus(token));
            if (!status.isHeating) await turnOnSide(token, profile.users.eightUserId);
            if (status.heatingLevel !== targetLevel) await setHeatingLevel(token, profile.users.eightUserId, targetLevel);
          }
        } else if (userNow > adjustedCycle.wakeupTime && !isNearWakeup) {
           if (!testMode?.enabled) await turnOffSide(token, profile.users.eightUserId);
           console.log("ACTION: Turning bed off (Past wakeup)");
        }
      } catch (e) { console.error(e); }
    }
  } catch (e) { console.error(e); }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  const testTime = request.nextUrl.searchParams.get("testTime");
  await adjustTemperature(testTime ? { enabled: true, currentTime: new Date(Number(testTime) * 1000) } : undefined);
  return Response.json({ success: true });
}
