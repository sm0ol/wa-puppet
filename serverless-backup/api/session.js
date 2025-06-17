import 'dotenv/config';
import pino from 'pino';
import puppeteerCore from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime
});

const antiCaptchaService = {
  async createTask(sitekey) {
    const response = await fetch('https://api.anti-captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: process.env.anti_key,
        task: {
          type: 'NoCaptchaTaskProxyless',
          websiteURL: 'https://lb.washassist.com/Home/Login',
          websiteKey: sitekey
        },
        softId: 0
      })
    });
    
    const result = await response.json();
    if (result.errorId !== 0) {
      throw new Error(`Anti-captcha create task error: ${result.errorDescription}`);
    }
    return result.taskId;
  },

  async getTaskResult(taskId) {
    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => setTimeout(resolve, 4000));
      
      const response = await fetch('https://api.anti-captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: process.env.anti_key,
          taskId
        })
      });
      
      const result = await response.json();
      if (result.status === 'ready') {
        return result.solution.gRecaptchaResponse;
      }
    }
    throw new Error('Captcha timeout');
  }
};

const browserService = {
  async launch() {
    try {
      logger.info('Launching browser with chrome-aws-lambda for serverless');
      
      const browser = await puppeteerCore.launch({
        args: [
          ...chromium.args,
          '--hide-scrollbars',
          '--disable-web-security',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          `--user-agent=${process.env.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}`
        ],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      });
      
      return browser;
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to launch browser');
      throw error;
    }
  }
};

const washAssistService = {
  async login(user, pass, code) {
    const startTime = Date.now();
    logger.info({ phase: 'start', user }, 'Starting login process');
    
    let browser;
    try {
      browser = await browserService.launch();
      const page = await browser.newPage();
      
      logger.info({ phase: 'navigate' }, 'Navigating to washassist');
      await page.goto('https://lb.washassist.com/', { waitUntil: 'domcontentloaded' });
      
      logger.info({ phase: 'extract_sitekey' }, 'Extracting reCAPTCHA sitekey');
      const sitekey = await page.$eval('#desktop-captcha', el => el.dataset.sitekey);
      
      logger.info({ phase: 'solve_captcha' }, 'Solving captcha');
      const taskId = await antiCaptchaService.createTask(sitekey);
      const token = await antiCaptchaService.getTaskResult(taskId);
      
      logger.info({ phase: 'fill_form' }, 'Filling login form');
      await page.type('#idLogin', user);
      await page.type('#idPassword', pass);
      await page.type('#idCustomerCode', code);
      
      await page.evaluate(token => {
        document.querySelector('textarea[name="g-recaptcha-response"]').value = token;
      }, token);
      
      const navigationPromise = page.waitForNavigation({ 
        timeout: 15000, 
        waitUntil: 'networkidle2' 
      });
      
      await page.click('.submit-login');
      await navigationPromise;
      
      logger.info({ phase: 'check_2fa' }, 'Checking 2FA status');
      const twofa = await page.evaluate(async () => {
        try {
          const response = await fetch('/Home/CheckTwoFacotEnabledOrResendOtp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ loginData: {} })
          });
          return response.ok ? (await response.json()).isEnabled : false;
        } catch (e) {
          return false;
        }
      });
      
      if (twofa) {
        throw new Error('2FA enabled – abort / ask user to disable');
      }
      
      logger.info({ phase: 'harvest_cookies' }, 'Harvesting cookies');
      const cookiePick = ["ASP.NET_SessionId", ".micrologicAUTH", "r_ssoCookie"];
      const rawCookies = await page.cookies();
      const filteredCookies = rawCookies.filter(c => cookiePick.includes(c.name));
      const cookieJar = filteredCookies.map(c => `${c.name}=${c.value}`).join('; ');
      
      const expires = new Date(Date.now() + 25 * 60 * 1000).toISOString();
      const elapsed = Date.now() - startTime;
      
      logger.info({ 
        phase: 'complete', 
        elapsed,
        cookieCount: filteredCookies.length 
      }, 'Login completed successfully');
      
      return {
        cookies: [cookieJar],
        expires
      };
      
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.error({ 
        phase: 'error', 
        elapsed,
        error: error.message 
      }, 'Login failed');
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { user, pass, code } = req.body;
    
    if (!user || !pass || !code) {
      return res.status(400).json({ 
        error: 'Missing required fields: user, pass, code' 
      });
    }
    
    const result = await washAssistService.login(user, pass, code);
    return res.status(200).json(result);
    
  } catch (error) {
    if (error.message.includes('2FA enabled')) {
      return res.status(428).json({ error: error.message });
    }
    
    if (error.message.includes('Captcha timeout')) {
      return res.status(428).json({ error: 'Captcha solver timed out' });
    }
    
    if (error.message.includes('credentials') || error.message.includes('401')) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    logger.error({ error: error.message }, 'Internal server error');
    return res.status(500).json({ error: 'Internal server error' });
  }
}