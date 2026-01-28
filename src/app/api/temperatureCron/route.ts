import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type Token } from "~/server/eight/types";
import { setHeatingLevel, turnOnSide, turnOffSide } from "~/server/eight/eight";
import { getCurrentHeatingStatus } from "~/server/eight/user";

export const runtime = "nodejs";

// Helper for date manipulation
function createDateWithTime(baseDate: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(':').map(Number);
  const result = new Date(baseDate);
  result.setHours(hours ?? 0, minutes ?? 0, 0, 0);
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

function createSleepCycle(baseDate: Date, bedTimeStr: string, wakeupTimeStr: string): any {
  const preHeatingTime = createDateWithTime(baseDate, bedTimeStr);
  preHeatingTime.setHours(preHeatingTime.getHours() - 3); // 3 HOURS BEFORE
  
  const bedTime = createDateWithTime(baseDate, bedTimeStr);
  let wakeupTime = createDateWithTime(baseDate, wakeupTimeStr);
  if (wakeupTime <= bedTime) wakeupTime = addDays(wakeupTime, 1);
  
  const midStageTime = new Date(bedTime.getTime() + 60 * 60 * 1000);
  const finalStageTime = new Date(wakeupTime.getTime() - 2 * 60 * 60 * 1000);
  
  return { preHeatingTime, bedTime, midStageTime, finalStageTime, wakeupTime };
}

export async function adjustTemperature(testMode?: { enabled: boolean; currentTime: Date }): Promise<void> {
  const profiles = await db.select().from(userTemperatureProfile).innerJoin(users, eq(userTemperatureProfile.email, users.email));

  for (const profile of profiles) {
    try {
      const userTemp = profile.userTemperatureProfiles;
      const now = testMode?.enabled ? testMode.currentTime : new Date();
      const userNow = new Date(now.toLocaleString("en-US", { timeZone: userTemp.timezoneTZ }));

      // 1. Refresh Token if needed
      let token: Token = {
        eightAccessToken: profile.users.eightAccessToken,
        eightRefreshToken: profile.users.eightRefreshToken,
        eightExpiresAtPosix: profile.users.eightTokenExpiresAt.getTime(),
        eightUserId: profile.users.eightUserId,
      };

      if (!testMode?.enabled && now.getTime() > token.eightExpiresAtPosix) {
        console.log(`Refreshing token for ${profile.users.email}`);
        token = await obtainFreshAccessToken(token.eightRefreshToken, token.eightUserId);
        await db.update(users).set({
          eightAccessToken: token.eightAccessToken,
          eightRefreshToken: token.eightRefreshToken,
          eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
        }).where(eq(users.email, profile.users.email));
      }

      // 2. Calculate Cycle
      const cycle = createSleepCycle(userNow, userTemp.bedTime, userTemp.wakeupTime);
      
      // 3. Determine Stage
      const isPreHeating = userNow >= cycle.preHeatingTime && userNow < cycle.bedTime;
      const isInitial = userNow >= cycle.bedTime && userNow < cycle.midStageTime;
      const isMid = userNow >= cycle.midStageTime && userNow < cycle.finalStageTime;
      const isFinal = userNow >= cycle.finalStageTime && userNow < cycle.wakeupTime;

      let targetLevel: number | null = null;
      if (isPreHeating || isInitial) targetLevel = userTemp.initialSleepLevel;
      else if (isMid) targetLevel = userTemp.midStageSleepLevel;
      else if (isFinal) targetLevel = userTemp.finalSleepLevel;

      console.log(`User: ${profile.users.email} | Now: ${userNow.toLocaleTimeString()} | Target: ${targetLevel}`);

      // 4. Execute
      if (targetLevel !== null) {
        if (!testMode?.enabled) {
          // ALWAYS ensure it is ON first
          await retryApiCall(() => turnOnSide(token, profile.users.eightUserId));
          await retryApiCall(() => setHeatingLevel(token, profile.users.eightUserId, targetLevel!));
          console.log(`SUCCESS: Set ${profile.users.email} to ${targetLevel}`);
        }
      } else if (userNow > cycle.wakeupTime) {
        if (!testMode?.enabled) await retryApiCall(() => turnOffSide(token, profile.users.eightUserId));
        console.log("Bed turned OFF after wakeup.");
      }
    } catch (err) {
      console.error("Critical error in loop:", err);
    }
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  
  const testTimeParam = request.nextUrl.searchParams.get("testTime");
  if (testTimeParam) {
    await adjustTemperature({ enabled: true, currentTime: new Date(Number(testTimeParam) * 1000) });
  } else {
    await adjustTemperature();
  }
  return Response.json({ success: true });
}
