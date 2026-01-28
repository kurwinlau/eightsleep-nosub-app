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
  wakeupTime: Date;
}

function createSleepCycle(baseDate: Date, bedTimeStr: string, wakeupTimeStr: string): SleepCycle {
  const preHeatingTime = createDateWithTime(baseDate, bedTimeStr);
  // START 3 HOURS BEFORE BEDTIME
  preHeatingTime.setHours(preHeatingTime.getHours() - 3); 
  
  const bedTime = createDateWithTime(baseDate, bedTimeStr);
  let wakeupTime = createDateWithTime(baseDate, wakeupTimeStr);
  
  if (wakeupTime <= bedTime) {
    wakeupTime = addDays(wakeupTime, 1);
  }
  
  const midStageTime = new Date(bedTime.getTime() + 60 * 60 * 1000);
  const finalStageTime = new Date(wakeupTime.getTime() - 2 * 60 * 60 * 1000);
  
  return { preHeatingTime, bedTime, midStageTime, finalStageTime, wakeupTime };
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
        const userTemp = profile.userTemperatureProfiles;
        const userNow = new Date(now.toLocaleString("en-US", { timeZone: userTemp.timezoneTZ }));

        const sleepCycle = createSleepCycle(userNow, userTemp.bedTime, userTemp.wakeupTime);
        const cycleStart = sleepCycle.preHeatingTime;
        
        const adjustedCycle: SleepCycle = {
          preHeatingTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.preHeatingTime),
          bedTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.bedTime),
          midStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.midStageTime),
          finalStageTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.finalStageTime),
          wakeupTime: adjustTimeToCurrentCycle(cycleStart, userNow, sleepCycle.wakeupTime),
        };

        let heatingStatus;
        if (testMode?.enabled) {
          heatingStatus = { isHeating: false, heatingLevel: 0 };
        } else {
          heatingStatus = await retryApiCall(() => getCurrentHeatingStatus(token));
        }

        // WINDOW-BASED LOGIC (Checks if current time is INSIDE the range)
        const isPreHeating = userNow >= adjustedCycle.preHeatingTime && userNow < adjustedCycle.bedTime;
        const isInitial = userNow >= adjustedCycle.bedTime && userNow < adjustedCycle.midStageTime;
        const isMid = userNow >= adjustedCycle.midStageTime && userNow < adjustedCycle.finalStageTime;
        const isFinal = userNow >= adjustedCycle.finalStageTime && userNow < adjustedCycle.wakeupTime;

        let targetLevel: number | null = null;
        let sleepStage = "";

        if (isPreHeating) {
          targetLevel = userTemp.initialSleepLevel;
          sleepStage = "pre-heating (3-hour window)";
        } else if (isInitial) {
          targetLevel = userTemp.initialSleepLevel;
          sleepStage = "initial";
        } else if (isMid) {
          targetLevel = userTemp.midStageSleepLevel;
          sleepStage = "mid";
        } else if (isFinal) {
          targetLevel = userTemp.finalSleepLevel;
          sleepStage = "final";
        }

        if (targetLevel !== null) {
          console.log(`User: ${profile.users.email} | Stage: ${sleepStage} | Target: ${targetLevel}`);

          if (!heatingStatus.isHeating) {
            if (!testMode?.enabled) await retryApiCall(() => turnOnSide(token, profile.users.eightUserId));
          }
          if (heatingStatus.heatingLevel !== targetLevel) {
            if (!testMode?.enabled) await retryApiCall(() => setHeatingLevel(token, profile.users.eightUserId, targetLevel));
          }
        } else if (heatingStatus.isHeating && userNow > adjustedCycle.wakeupTime) {
          // Automatic shutoff after wake-up
          if (!testMode?.enabled) await retryApiCall(() => turnOffSide(token, profile.users.eightUserId));
          console.log(`User: ${profile.users.email} | Status: Off (Post-Wakeup)`);
        }
      } catch (error) {
        console.error(`Error for ${profile.users.email}:`, error);
      }
    }
  } catch (error) {
    console.error("Critical error:", error);
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
    return new Response("Internal error", { status: 500 });
  }
}
