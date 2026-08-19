import { GetInitLoginResponse, OtpV2Response } from "@/types/response"
import crypto from "crypto"
import { session } from "electron"
import { decodeLaunchData } from "../helpers/launch"
import { resolveClientIntegrity } from "../helpers/resolve_client_integrity"
import { BEAN_FUN_HOST, beanfunFetch } from "./request"

export interface ServiceAccount {
  clickable: boolean
  id: string
  ssn: string
  name: string
  createTime: string
}

export interface GetAccountsResult {
  accountList: ServiceAccount[]
  accountAmountLimitNotice: string
}

async function getAccounts(
  webToken: string,
  serviceCode: string,
  serviceRegion: string,
  fatal = true
): Promise<GetAccountsResult> {
  const host = "tw.beanfun.com"

  // 先打 auth.aspx 初始化
  await beanfunFetch(
    `https://${host}/beanfun_block/auth.aspx?channel=game_zone&page_and_query=game_start.aspx%3Fservice_code_and_region%3D${serviceCode}_${serviceRegion}&web_token=${webToken}`
  )

  // 再抓帳號清單 HTML
  const response = await beanfunFetch(
    `https://${host}/beanfun_block/game_zone/game_server_account_list.aspx?sc=${serviceCode}&sr=${serviceRegion}&dt=${Date.now()}`
  )

  const htmlStr = await response.text()
  // console.log("htmlStr: ", htmlStr)

  // 抓帳號列表
  const accountRegex =
    /onclick="([^"]*)"><div id="(\w+)" sn="(\d+)" name="([^"]+)"/g

  let accountList: ServiceAccount[] = []
  let match: RegExpExecArray | null

  while ((match = accountRegex.exec(htmlStr)) !== null) {
    const [, onclick, id, ssn, name] = match
    if (!id || !ssn || !name) continue

    accountList.push({
      clickable: onclick !== "",
      id,
      ssn,
      name: decodeURIComponent(name),
      createTime: null,
    })
  }

  // update createTime
  accountList = await Promise.all(
    accountList.map(async (acc) => {
      return {
        ...acc,
        createTime: await getCreateTime(serviceCode, serviceRegion, acc.ssn),
      }
    })
  )

  // 抓提示訊息
  const noticeRegex =
    /<div id="divServiceAccountAmountLimitNotice" class="InnerContent">(.*)<\/div>/
  const noticeMatch = htmlStr.match(noticeRegex)

  let accountAmountLimitNotice = ""
  if (noticeMatch) {
    accountAmountLimitNotice = noticeMatch[1]
    if (accountAmountLimitNotice.includes("進階認證")) {
      accountAmountLimitNotice = "AuthReLogin"
    }
  }

  // 排序
  accountList.sort((a, b) => a.ssn.localeCompare(b.ssn))

  return { accountList, accountAmountLimitNotice }
}

// public int getRemainPoint(){
//     string response = null;
//     System.Text.RegularExpressions.Regex regex;

//     string url = "https://";
//     if (App.LoginRegion == "TW")
//         url += "tw";
//     else
//         url += "bfweb.hk";
//     response = this.DownloadString(url += ".beanfun.com/beanfun_block/generic_handlers/get_remain_point.ashx?webtoken=1");

//     try
//     {
//         regex = new System.Text.RegularExpressions.Regex("\"RemainPoint\" : \"(.*)\" }");
//         if (regex.IsMatch(response))
//             return int.Parse(regex.Match(response).Groups[1].Value);
//         else
//             return 0;
//     }
//     catch
//     { return 0; }
// }

async function getOTP(
  serviceAccount: ServiceAccount,
  serviceCode = "610074",
  serviceRegion = "T9"
) {
  const beanfunCookies = await session.defaultSession.cookies.get({
    url: `https://${BEAN_FUN_HOST}`,
  })

  const webToken = beanfunCookies.find(
    (cookie) => cookie.name === "bfWebToken"
  )?.value

  // ===============================
  // Step1: game_start_step2.aspx
  // ===============================
  // 1. long_polling_key can regx GetResultByLongPolling
  // 2. unk_data can regx
  // 3. screatetime can direct get
  // 4. page_url can direct get
  // 5. launch can regex m_objData
  //  5-1 sn
  //  5-2 data
  //  5-3 web_token?
  //  5-4 secret_code?

  //? 取得otp前置需要的資料
  const { longPollingKey, unkData, screatetime, pageUrl, launch } =
    await getOTPStep1(serviceAccount, serviceCode, serviceRegion)

  if (!serviceAccount.createTime) {
    serviceAccount.createTime = screatetime
  }

  // ? get SecretCode legacy
  /*console.log("Step4: get_cookies.ashx → SecretCode")
  const getCookiesResponse = await beanfunFetch(
    `https://${BEAN_FUN_LOGIN_HOST}/generic_handlers/get_cookies.ashx`
  )
  const getCookiesHtmlStr = await getCookiesResponse.text()
  const match = getCookiesHtmlStr.match(/var m_strSecretCode = '(.*)';/)
  if (!match) {
    console.log("OTPNoSecretCode")
    throw new Error("OTPNoSecretCode")
  }
  const secretCode = match[1]
  */

  // ? next step record_start
  const payload: Record<string, string> = {
    service_code: serviceCode,
    service_region: serviceRegion,
    service_account_id: serviceAccount.id,
    sotp: serviceAccount.ssn,
    service_account_display_name: serviceAccount.name,
    service_account_create_time: serviceAccount.createTime,
  }

  let unkKey: string | null = null
  let unkValue: string | null = null
  // unkKey = decodeURIComponent(match[1])
  // unkValue = decodeURIComponent(match[2])
  unkKey = unkData[0]
  unkValue = unkData[1]
  if (unkKey && unkValue) {
    payload[unkKey] = unkValue
  }

  await beanfunFetch(
    `https://${BEAN_FUN_HOST}/beanfun_block/generic_handlers/record_service_start.ashx`,
    {
      method: "POST",
      body: new URLSearchParams(payload).toString(),
      referrer: pageUrl,
    }
  )

  // v2 登入流程，故意不送 secret code，也故意不做 long polling
  // 確認 launcher 是否已經安裝 / 是否存在。
  const integrity = await resolveClientIntegrity()
  const decodedLaunchData = decodeLaunchData(launch.data)

  switch (decodedLaunchData.kind) {
    case "ticket":
      {
        try {
          const postOTPResponse = await beanfunFetch(
            `https://${BEAN_FUN_HOST}/beanfun_block/generic_handlers/get_webstart_otp_v2.ashx`,
            {
              referrer: pageUrl,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                SN: launch.sn,
                LaunchTicket: decodedLaunchData.ticket,
                CV: integrity.cv,
                Hash: integrity.hash,
                arch: integrity.arch,
              }),
            }
          )

          if (postOTPResponse.status !== 200) {
            throw new Error(`status: ${postOTPResponse.status}`)
          }

          const response = (await postOTPResponse.json()) as OtpV2Response
          if (response.result !== 1) {
            throw new Error(`result: ${response.result}`)
          }

          const encrypted = response.data
          const key = encrypted.substring(0, 8)
          const plainHex = encrypted.substring(8)

          const decipher = crypto.createDecipheriv(
            "des-ecb",
            Buffer.from(key, "ascii"),
            null
          )

          decipher.setAutoPadding(false)

          let decrypted = decipher.update(Buffer.from(plainHex, "hex"))
          decrypted = Buffer.concat([decrypted, decipher.final()])

          const otp = decrypted.toString("utf8").replace(/\0/g, "").trim()
          // console.log({ encrypted, key, decipher, otp })
          return otp
        } catch (error) {
          console.log("error for postOTPResponse", error)
        }
      }
      break
    case "legacy":
      throw new Error("not implement legacy action")
    default:
      throw new Error("mismatch decode kind")
  }
  return undefined
}

async function signOut() {
  const host = "tw.beanfun.com"
  const loginHost = "tw.newlogin.beanfun.com"

  try {
    await beanfunFetch(
      `https://${host}/generic_handlers/remove_bflogin_session.ashx`
    )
    await beanfunFetch(`https://${loginHost}/logout.aspx?service=999999_T0`)

    // TW
    await beanfunFetch(
      `https://tw.newlogin.beanfun.com/generic_handlers/erase_token.ashx`,
      {
        method: "POST",
        body: new URLSearchParams({ web_token: "1" }).toString(),
      }
    )

    return true
  } catch (err) {
    return false
  }
}

async function pingToken() {
  const reponse = await beanfunFetch(
    `https://tw.beanfun.com/beanfun_block/generic_handlers/echo_token.ashx?webtoken=1`
  )
  const htmlStr = await reponse.text()
  return htmlStr
}

async function getInitLogin(pSkey: string): Promise<GetInitLoginResponse> {
  const reponse = await beanfunFetch(
    `https://login.beanfun.com/Login/InitLogin`,
    {
      referrer: `https://login.beanfun.com/Login/Index?pSKey=${pSkey}`,
    }
  )
  const responseJson = await reponse.json()
  return responseJson
}

function getCurrentTime(method = 0): string {
  const date = new Date()

  const pad = (n: number, len = 2) => n.toString().padStart(len, "0")

  switch (method) {
    case 1:
      return (
        (date.getFullYear() - 1900).toString() + // 年 - 1900
        date.getMonth().toString() + // 月 - 1 (getMonth 已經是 0~11)
        pad(date.getDate()) +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds()) +
        pad(date.getMilliseconds(), 3)
      )
    case 2:
      return (
        date.getFullYear().toString() + // 年
        date.getMonth().toString() + // 月 - 1 (getMonth 0~11)
        pad(date.getDate()) +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds()) +
        pad(date.getMilliseconds(), 3)
      )
    default:
      return (
        pad(date.getFullYear(), 4) +
        pad(date.getMonth() + 1) + // Node.js month 0~11 → 補回 1
        pad(date.getDate()) +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds()) +
        "." +
        pad(date.getMilliseconds(), 3)
      )
  }
}

async function getCreateTime(
  serviceCode: string,
  serviceRegion: string,
  sn: string
): Promise<null | string> {
  const response = await beanfunFetch(
    `https://tw.beanfun.com/beanfun_block/game_zone/game_start_step2.aspx?service_code=${serviceCode}&service_region=$${serviceRegion}&sotp=${sn}&dt=${getCurrentTime(2)}`
  )
  const htmlStr = await response.text()

  // console.log("getCreateTime response: ", response)
  // Regex 抓 ServiceAccountCreateTime
  const match = htmlStr.match(/ServiceAccountCreateTime: "([^"]+)"/)

  if (!match) return null

  return match[1]
}

async function getOTPStep1(
  serviceAccount: ServiceAccount,
  serviceCode = "610074",
  serviceRegion = "T9"
) {
  const url = `https://${BEAN_FUN_HOST}/beanfun_block/game_zone/game_start_step2.aspx?service_code=${serviceCode}&service_region=${serviceRegion}&sotp=${serviceAccount.ssn}&dt=${getCurrentTime(2)}`
  const response = await beanfunFetch(url)
  const html = await response.text()

  let screatetime
  let match = html.match(/GetResultByLongPolling&key=(.*)"/)
  if (!match) {
    throw new Error("GetResultByLongPolling&key=?")
  }
  const longPollingKey = match[1]

  if (!serviceAccount.createTime) {
    match = html.match(/ServiceAccountCreateTime: "([^"]+)"/)
    if (!match) {
      console.log("OTPNoCreateTime")
      throw new Error("OTPNoCreateTime")
    }
    screatetime = match[1]
  }

  const block = html.match(/var m_objData\s*=\s*\{([\s\S]*?)\}/)[1]
  const sn = block.match(/"sn":\s*"([^"]+)"/)[1]
  const data = block.match(/"data":\s*"([^"]+)"/)[1]

  const parseUnkData = (html: string) => {
    const regex = /MyAccountData.ServiceAccountCreateTime \+ "(.*)=(.*)";/
    const match = regex.exec(html)
    if (!match) {
      throw new Error("OtpMissingUnkData")
    }

    const rawKey = match[1] ?? ""
    const rawValue = match[2] ?? ""

    let key, value
    try {
      // decodeURIComponent 對應 percent_decode_str().decode_utf8()
      key = decodeURIComponent(rawKey)
      value = decodeURIComponent(rawValue)
    } catch {
      // decodeURIComponent 在遇到不合法的 %XX 序列會 throw URIError
      throw new Error("OtpMissingUnkData")
    }

    return [key, value]
  }

  return {
    longPollingKey,
    unkData: parseUnkData(html),
    screatetime,
    pageUrl: url,
    // m_objData
    launch: {
      sn,
      data,
      // web_token?
      // secret_code?
    },
  }
}

export { getAccounts, getInitLogin, getOTP, pingToken, signOut }
