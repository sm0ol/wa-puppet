import 'dotenv/config';
import Fastify from 'fastify';
import pino from 'pino';
import puppeteer from 'puppeteer';

// Environment detection
const isVercel = process.env.VERCEL || process.env.NOW_REGION;
const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime
});

const fastify = Fastify({ 
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
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
    const maxAttempts = 20; // Increased attempts
    const interval = 3000; // Reduced interval to 3 seconds
    const startTime = Date.now();
    const maxWaitTime = 90000; // 90 seconds max wait to stay under 2-minute token validity
    
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, interval));
      
      const elapsed = Date.now() - startTime;
      if (elapsed > maxWaitTime) {
        throw new Error(`Captcha timeout after ${elapsed}ms - token would expire`);
      }
      
      const response = await fetch('https://api.anti-captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: process.env.anti_key,
          taskId
        })
      });
      
      const result = await response.json();
      
      if (result.errorId !== 0) {
        throw new Error(`Anti-captcha get result error: ${result.errorDescription}`);
      }
      
      if (result.status === 'ready') {
        logger.info({ elapsed, attempts: i + 1 }, 'Captcha solved successfully');
        return result.solution.gRecaptchaResponse;
      }
      
      if (result.status === 'processing') {
        logger.debug({ attempt: i + 1, elapsed }, 'Captcha still processing');
        continue;
      }
      
      // Handle other statuses
      throw new Error(`Unexpected captcha status: ${result.status}`);
    }
    
    const elapsed = Date.now() - startTime;
    throw new Error(`Captcha timeout after ${maxAttempts} attempts (${elapsed}ms)`);
  }
};

const browserService = {
  async launch() {
    const args = [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--user-agent=${process.env.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}`
    ];

    if (process.env.proxy_url) {
      args.push(`--proxy-server=${process.env.proxy_url}`);
    }

    // Handle different deployment environments
    let launchOptions = {
      headless: process.env.headless !== 'false',
      args
    };

    if (isVercel) {
      // Vercel hosted app - use regular Puppeteer
      logger.info('Launching browser for Vercel hosted app');
      launchOptions.args.push('--single-process'); // Important for Vercel
    } else if (isProduction) {
      // Docker/container environment
      launchOptions.executablePath = '/usr/bin/chromium-browser';
    }
    // Local development uses default puppeteer Chrome
    
    logger.info({ launchOptions }, 'Launching browser');
    const browser = await puppeteer.launch(launchOptions);
    return browser;
  }
};

const webhookService = {
  async callWebhook(webhookUrl, payload) {
    try {
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
      logger.info({ webhookUrl, requestId: payload.request_id }, 'Calling webhook');
      
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error(`Webhook call failed with status ${response.status}`);
      }
      
      logger.info({ webhookUrl, requestId: payload.request_id, status: response.status }, 'Webhook called successfully');
    } catch (error) {
      logger.error({ 
        webhookUrl, 
        requestId: payload.request_id, 
        error: error.message 
      }, 'Webhook call failed');
      // Note: We don't throw here to avoid crashing the async process
    }
  }
};

const washAssistService = {
  async processAuthAsync(requestId, webhookUrl, user, pass, code) {
    logger.info({ requestId, phase: 'async_start' }, 'Starting async authentication');
    
    try {
      const result = await this.login(user, pass, code);
      
      // Call success webhook
      await webhookService.callWebhook(webhookUrl, {
        request_id: requestId,
        success: true,
        cookies: result.cookies,
        expires: result.expires
      });
      
      logger.info({ requestId, phase: 'async_complete' }, 'Async authentication completed successfully');
    } catch (error) {
      logger.error({ requestId, phase: 'async_error', error: error.message }, 'Async authentication failed');
      
      // Call failure webhook
      await webhookService.callWebhook(webhookUrl, {
        request_id: requestId,
        success: false,
        error: `Authentication failed: ${error.message}`
      });
    }
  },

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
      
      // Try multiple selectors for the captcha element
      let sitekey;
      const captchaSelectors = ['#desktop-captcha', '.g-recaptcha', '[data-sitekey]'];
      for (const selector of captchaSelectors) {
        try {
          sitekey = await page.$eval(selector, el => el.dataset.sitekey || el.getAttribute('data-sitekey'));
          if (sitekey) break;
        } catch (e) {
          logger.debug({ selector, error: e.message }, 'Captcha selector not found');
        }
      }
      
      if (!sitekey) {
        throw new Error('Could not extract reCAPTCHA sitekey from page');
      }
      
      logger.info({ sitekey }, 'Found reCAPTCHA sitekey');
      
      // Start captcha solving and form filling in parallel to save time
      logger.info({ phase: 'solve_captcha' }, 'Starting captcha solve');
      const captchaStartTime = Date.now();
      const taskId = await antiCaptchaService.createTask(sitekey);
      
      logger.info({ phase: 'fill_form' }, 'Filling login form while captcha solves');
      await page.type('#idLogin', user);
      await page.type('#idPassword', pass);
      await page.type('#idCustomerCode', code);
      
      // Get captcha token
      const token = await antiCaptchaService.getTaskResult(taskId);
      const captchaElapsed = Date.now() - captchaStartTime;
      logger.info({ phase: 'captcha_solved', elapsed: captchaElapsed }, 'Captcha solved');
      
      // Inject token and trigger reCAPTCHA visual update
      logger.info({ phase: 'inject_token' }, 'Injecting captcha token and triggering visual update');
      const tokenInjected = await page.evaluate(token => {
        try {
          // Set the g-recaptcha-response textarea (standard reCAPTCHA field)
          const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
          if (textarea) {
            textarea.value = token;
            textarea.style.display = 'block';
          }
          
          // Set the CaptchaToken hidden field (ASP.NET specific)
          const captchaTokenField = document.querySelector('#CaptchaToken');
          if (captchaTokenField) {
            captchaTokenField.value = token;
          }
          
          // Get the reCAPTCHA widget ID and trigger callback
          const captchaContainer = document.querySelector('.g-recaptcha, #desktop-captcha');
          let callbackTriggered = false;
          
          if (captchaContainer) {
            // Method 1: Try to find and call the callback function
            const callback = captchaContainer.getAttribute('data-callback');
            if (callback && window[callback]) {
              window[callback](token);
              callbackTriggered = true;
            }
            
            // Method 2: Try to use grecaptcha.execute if available
            if (window.grecaptcha && !callbackTriggered) {
              try {
                // Look for widget ID in the iframe or container
                const iframe = captchaContainer.querySelector('iframe');
                if (iframe) {
                  // Extract widget ID from iframe name if possible
                  const iframeName = iframe.getAttribute('name');
                  if (iframeName && window.grecaptcha.getResponse) {
                    // Try to trigger the success callback manually
                    const widgetId = captchaContainer.getAttribute('data-widget-id') || 0;
                    if (window.grecaptcha.execute) {
                      window.grecaptcha.execute(widgetId);
                      callbackTriggered = true;
                    }
                  }
                }
              } catch (e) {
                console.log('grecaptcha.execute failed:', e);
              }
            }
            
            // Method 3: Try to simulate a successful reCAPTCHA by updating the visual state
            if (!callbackTriggered) {
              try {
                // Add the visual "success" class to the container
                captchaContainer.classList.add('recaptcha-success');
                
                // Look for the checkbox and mark it as checked
                const checkbox = captchaContainer.querySelector('.recaptcha-checkbox');
                if (checkbox) {
                  checkbox.classList.add('recaptcha-checkbox-checked');
                }
                
                // Dispatch a custom event to simulate completion
                const event = new CustomEvent('recaptcha-success', { 
                  detail: { token: token },
                  bubbles: true 
                });
                captchaContainer.dispatchEvent(event);
                callbackTriggered = true;
              } catch (e) {
                console.log('Visual state update failed:', e);
              }
            }
          }
          
          // Dispatch change events on form fields
          if (textarea) {
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
          
          if (captchaTokenField) {
            captchaTokenField.dispatchEvent(new Event('change', { bubbles: true }));
          }
          
          return {
            hasTextarea: !!textarea,
            hasCaptchaField: !!captchaTokenField,
            callbackTriggered: callbackTriggered,
            containerFound: !!captchaContainer
          };
        } catch (e) {
          console.error('Token injection error:', e);
          return { error: e.message };
        }
      }, token);
      
      if (tokenInjected.error) {
        throw new Error(`Failed to inject captcha token: ${tokenInjected.error}`);
      }
      
      if (!tokenInjected.hasTextarea || !tokenInjected.hasCaptchaField) {
        throw new Error('Failed to find required captcha fields on page');
      }
      
      logger.info({ 
        phase: 'token_injection_result', 
        ...tokenInjected 
      }, 'Token injection completed');
      
      // Wait a moment for any visual updates to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Verify captcha token is properly set
      const captchaStatus = await page.evaluate(() => {
        const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
        const captchaTokenField = document.querySelector('#CaptchaToken');
        const captchaContainer = document.querySelector('.g-recaptcha, #desktop-captcha');
        
        return {
          hasToken: textarea?.value?.length > 0,
          tokenLength: textarea?.value?.length || 0,
          captchaFieldSet: captchaTokenField?.value?.length > 0,
          containerClasses: captchaContainer?.className || '',
          isVisible: textarea ? getComputedStyle(textarea).display !== 'none' : false,
          containerHTML: captchaContainer?.outerHTML?.substring(0, 200) || ''
        };
      });
      
      logger.info({ phase: 'captcha_status', ...captchaStatus }, 'Final captcha status check');
      
      if (!captchaStatus.hasToken || !captchaStatus.captchaFieldSet) {
        throw new Error('Captcha token was not properly set in both required fields');
      }
      
      // Submit the login form via POST request (this is what actually happens in the browser)
      logger.info({ phase: 'submit_login' }, 'Submitting login via POST request');
      
      const loginResponse = await page.evaluate(async (user, pass, code, token) => {
        try {
          // Create form data exactly like the browser does
          const formData = new URLSearchParams();
          formData.append('TimeZoneOffset', '-360');
          formData.append('CaptchaToken', token);
          formData.append('UserName', user);
          formData.append('Password', pass);
          formData.append('CustomerCode', code);
          formData.append('OTPTOken', '');
          formData.append('bOTPTOken', '');
          formData.append('bResendOTPTOken', 'false');
          formData.append('g-recaptcha-response', token);
          
          const response = await fetch('/Home/Login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
              'Cache-Control': 'max-age=0',
              'Origin': 'https://lb.washassist.com',
              'Referer': 'https://lb.washassist.com/',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'same-origin',
              'Sec-Fetch-User': '?1',
              'Upgrade-Insecure-Requests': '1'
            },
            body: formData.toString()
          });
          
          return {
            status: response.status,
            ok: response.ok,
            url: response.url,
            redirected: response.redirected
          };
        } catch (error) {
          return {
            error: error.message
          };
        }
      }, user, pass, code, token);
      
      logger.info({ 
        phase: 'login_response', 
        response: loginResponse 
      }, 'Login POST response received');
      
      if (loginResponse.error) {
        throw new Error(`Login request failed: ${loginResponse.error}`);
      }
      
      if (!loginResponse.ok) {
        throw new Error(`Login failed with status ${loginResponse.status}`);
      }
      
      // Wait a moment for cookies to be set after successful login
      await new Promise(resolve => setTimeout(resolve, 3000));
      
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
      
      // Debug page state before harvesting cookies
      logger.info({ phase: 'debug_page_state' }, 'Debugging page state');
      const pageInfo = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        hasLoginForm: !!document.querySelector('#idLogin'),
        hasErrorMessages: !!document.querySelector('.error, .alert-danger, .validation-summary-errors'),
        bodyText: document.body.innerText.substring(0, 500), // First 500 chars
        readyState: document.readyState
      }));
      
      logger.info({ phase: 'page_info', pageInfo }, 'Current page state');
      
      // Take screenshot for debugging
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotPath = `/tmp/washassist-debug-${timestamp}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info({ phase: 'screenshot', path: screenshotPath }, 'Screenshot saved');
      } catch (screenshotError) {
        logger.warn({ error: screenshotError.message }, 'Failed to take screenshot');
      }
      
      logger.info({ phase: 'harvest_cookies' }, 'Harvesting cookies');
      const cookiePick = ["ASP.NET_SessionId", ".micrologicAUTH", "r_ssoCookie"];
      
      // Retry mechanism to wait for all required cookies
      let filteredCookies = [];
      const maxRetries = 20; // ~10 seconds with 500ms intervals
      const retryInterval = 500;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Get all cookies from current page/domain
        const rawCookies = await page.cookies();
        
        // Also try to get cookies from common WashAssist domains
        let additionalCookies = [];
        try {
          const washAssistCookies = await page.cookies('https://washassist.com');
          const lbWashAssistCookies = await page.cookies('https://lb.washassist.com');
          additionalCookies = [...washAssistCookies, ...lbWashAssistCookies];
        } catch (e) {
          logger.debug({ error: e.message }, 'Could not fetch cookies from additional domains');
        }
        
        const allCookies = [...rawCookies, ...additionalCookies];
        
        // Remove duplicates based on name and domain
        const uniqueCookies = allCookies.filter((cookie, index, arr) => 
          arr.findIndex(c => c.name === cookie.name && c.domain === cookie.domain) === index
        );
        
        // Log all cookies for debugging
        logger.info({ 
          phase: 'raw_cookies', 
          attempt: attempt + 1,
          currentUrl: await page.url(),
          totalCookies: uniqueCookies.length,
          allCookieNames: uniqueCookies.map(c => c.name),
          rawCookies: uniqueCookies.map(c => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure }))
        }, 'All cookies found after login');
        
        filteredCookies = uniqueCookies.filter(c => cookiePick.includes(c.name));
        
        // Check if we have all required cookies
        const foundCookieNames = filteredCookies.map(c => c.name);
        const missingCookies = cookiePick.filter(name => !foundCookieNames.includes(name));
        
        if (missingCookies.length === 0) {
          logger.info({ 
            phase: 'harvest_cookies', 
            attempt: attempt + 1,
            cookiesFound: foundCookieNames 
          }, 'All required cookies found');
          break;
        }
        
        logger.info({ 
          phase: 'harvest_cookies', 
          attempt: attempt + 1,
          missingCookies,
          foundCookies: foundCookieNames
        }, 'Waiting for missing cookies');
        
        if (attempt === maxRetries - 1) {
          throw new Error(`Missing required cookies after ${maxRetries * retryInterval}ms: ${missingCookies.join(', ')}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      }
      
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

fastify.post('/session-async', async (request, reply) => {
  try {
    const { request_id, webhook_url, user, pass, code } = request.body;
    
    if (!request_id || !webhook_url || !user || !pass || !code) {
      return reply.code(400).send({ 
        error: 'Missing required fields: request_id, webhook_url, user, pass, code' 
      });
    }
    
    // Validate webhook URL format
    try {
      new URL(webhook_url);
    } catch {
      return reply.code(400).send({ 
        error: 'Invalid webhook_url format' 
      });
    }
    
    // Start async processing without waiting
    setImmediate(() => {
      washAssistService.processAuthAsync(request_id, webhook_url, user, pass, code);
    });
    
    return reply.code(202).send({
      success: true,
      message: 'Authentication request queued',
      request_id
    });
    
  } catch (error) {
    logger.error({ error: error.message }, 'Session-async endpoint error');
    return reply.code(500).send({ error: 'Internal server error' });
  }
});

fastify.post('/session', async (request, reply) => {
  try {
    const { user, pass, code } = request.body;
    
    if (!user || !pass || !code) {
      return reply.code(400).send({ 
        error: 'Missing required fields: user, pass, code' 
      });
    }
    
    const result = await washAssistService.login(user, pass, code);
    return reply.send(result);
    
  } catch (error) {
    if (error.message.includes('2FA enabled')) {
      return reply.code(428).send({ error: error.message });
    }
    
    if (error.message.includes('Captcha timeout')) {
      return reply.code(428).send({ error: 'Captcha solver timed out' });
    }
    
    if (error.message.includes('Missing required cookies')) {
      return reply.code(500).send({ error: 'Authentication cookies not received - login may have failed' });
    }
    
    if (error.message.includes('credentials') || error.message.includes('401')) {
      return reply.code(400).send({ error: 'Invalid credentials' });
    }
    
    logger.error({ error: error.message }, 'Internal server error');
    return reply.code(500).send({ error: 'Internal server error' });
  }
});

fastify.post('/refresh', async (request, reply) => {
  return reply.code(501).send({ 
    error: 'Refresh endpoint not implemented - use /session endpoint' 
  });
});

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    const host = process.env.HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    logger.info({ port, host }, 'Server listening');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// For local development and testing
if (!isVercel) {
  start();
}

// Export fastify instance for server.js
export default fastify;