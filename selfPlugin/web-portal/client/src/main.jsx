import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Button, ConfigProvider, Form, Input, Modal, theme } from 'antd';
import { ArrowRightOutlined, ArrowUpOutlined, CustomerServiceOutlined, LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import 'antd/dist/reset.css';
import './style.css';
import { loginLocale as copy } from './locale.js';

function Mark({ small = false }) {
  return <svg className={small ? 'brand-mark small' : 'brand-mark'} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M10 27V13l20 14V13M10 20l20-7M10 27l20-7" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function AgentSphere() {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const points = Array.from({ length: 1500 }, (_, i) => {
      const y = 1 - (i / 1499) * 2;
      const radius = Math.sqrt(1 - y * y);
      const angle = Math.PI * (3 - Math.sqrt(5)) * i;
      return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius };
    });
    let width = 0, height = 0, frame = 0, pointerX = 0, pointerY = 0;
    const resize = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reducedMotion.matches) draw(0);
    });
    function draw(time) {
      context.clearRect(0, 0, width, height);
      const rotation = time * 0.000065 + 0.4 + pointerX * 0.15;
      const tilt = -0.16 + pointerY * 0.1;
      const radius = Math.min(width * 0.31, height * 0.36);
      const cx = width / 2, cy = height / 2;
      const glow = context.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.5);
      glow.addColorStop(0, 'rgba(88, 210, 175, 0.065)');
      glow.addColorStop(1, 'rgba(88, 210, 175, 0)');
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);
      context.save();
      context.translate(cx, cy);
      context.rotate(-0.35);
      context.strokeStyle = 'rgba(162, 241, 210, 0.13)';
      context.lineWidth = 0.7;
      context.beginPath();
      context.ellipse(0, 0, radius * 1.43, radius * 0.48, 0, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([2, 7]);
      context.strokeStyle = 'rgba(162, 241, 210, 0.08)';
      context.beginPath();
      context.ellipse(0, 0, radius * 1.55, radius * 1.08, 0, 0, Math.PI * 2);
      context.stroke();
      context.restore();
      const projected = points.map(p => {
        const x = p.x * Math.cos(rotation) + p.z * Math.sin(rotation);
        const z = -p.x * Math.sin(rotation) + p.z * Math.cos(rotation);
        const y = p.y * Math.cos(tilt) - z * Math.sin(tilt);
        const depth = p.y * Math.sin(tilt) + z * Math.cos(tilt);
        const ripple = 1 + 0.025 * Math.sin(p.y * 9 + time * 0.00065);
        const perspective = 3.5 / (3.5 - depth);
        return { x: cx + x * radius * perspective * ripple, y: cy + y * radius * perspective * ripple, depth };
      }).sort((a, b) => a.depth - b.depth);
      for (const p of projected) {
        const front = (p.depth + 1) / 2;
        context.fillStyle = `rgba(166, 241, 216, ${0.09 + front * 0.64})`;
        context.beginPath();
        context.arc(p.x, p.y, 0.35 + front * 0.9, 0, Math.PI * 2);
        context.fill();
      }
      context.save();
      context.translate(cx, cy);
      context.rotate(-0.35);
      const orbit = time * 0.00025;
      const ox = Math.cos(orbit) * radius * 1.43, oy = Math.sin(orbit) * radius * 0.48;
      context.shadowBlur = 18;
      context.shadowColor = '#a2f1d2';
      context.fillStyle = '#c9ffed';
      context.beginPath();
      context.arc(ox, oy, 3, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
    function tick(time) {
      if (!document.hidden) draw(reducedMotion.matches ? 0 : time);
      if (!reducedMotion.matches) frame = requestAnimationFrame(tick);
    }
    function onMotionChange() { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); }
    function onPointer(event) {
      const rect = canvas.getBoundingClientRect();
      pointerX = (event.clientX - rect.left) / rect.width - 0.5;
      pointerY = (event.clientY - rect.top) / rect.height - 0.5;
    }
    resize.observe(canvas);
    canvas.addEventListener('pointermove', onPointer);
    reducedMotion.addEventListener('change', onMotionChange);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      canvas.removeEventListener('pointermove', onPointer);
      reducedMotion.removeEventListener('change', onMotionChange);
    };
  }, []);
  return <canvas ref={canvasRef} className="agent-sphere" aria-hidden="true" />;
}

const examples = copy.examples;

function App() {
  const [example, setExample] = useState(0);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const requestRef = useRef(null);
  const [form] = Form.useForm();
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 15_000);
    fetch('/portal/session', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (response.status === 401) return;
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('service_unavailable');
        const current = await response.json();
        if (current.authenticated !== true || !Number.isFinite(current.expiresAt)) throw new Error('service_unavailable');
        setSession(current);
      })
      .catch(() => { if (active) setError(copy.serviceUnavailable); })
      .finally(() => { clearTimeout(timer); if (active) setCheckingSession(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); requestRef.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { setSession(null); setError(copy.sessionExpired); }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);
  async function submit(values) {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => controller.abort(), 135_000);
    try {
      const response = await fetch('/portal/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: values.account.trim(), password: values.password }),
        signal: controller.signal,
      });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('service_unavailable');
      const result = await response.json();
      if (!response.ok || result.authenticated !== true) {
        setError(response.status === 401 ? copy.invalidCredentials : response.status === 429 ? copy.tooManyRequests : response.status === 403 ? copy.sessionRejected : copy.serviceUnavailable);
        return;
      }
      form.resetFields(['password']);
      window.location.replace('/');
    } catch { setError(copy.serviceUnavailable); }
    finally {
      clearTimeout(timer);
      requestRef.current = null;
      setLoading(false);
      form.resetFields(['password']);
    }
  }
  async function logout() {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch('/portal/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || (await response.json()).authenticated !== false) throw new Error('service_unavailable');
      setSession(null);
      form.resetFields(['password']);
    } catch { setError(copy.serviceUnavailable); }
    finally { clearTimeout(timer); requestRef.current = null; setLoading(false); }
  }
  const modalContent = copy.modals;
  return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: {
    colorPrimary: '#a2f1d2', colorBgBase: '#0b0f12', colorBgContainer: '#12191d',
    colorText: '#eef3f4', colorTextSecondary: '#9ba6ad', colorBorder: '#2b353b',
    borderRadius: 10, controlHeight: 52, fontSize: 14,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  }, components: {
    Button: { primaryColor: '#0c261d', colorPrimary: '#a2f1d2', colorPrimaryHover: '#bef8e1', colorPrimaryActive: '#80dcb8', fontWeight: 600 },
    Input: { activeBorderColor: '#91d7bd', hoverBorderColor: '#5a8274', activeShadow: '0 0 0 3px rgba(162,241,210,.08)' },
    Modal: { contentBg: '#141d22', headerBg: '#141d22' },
  } }}>
    <div className="page">
      <header className="topbar">
        <a href="/" className="brand" aria-label={copy.brandLabel}><Mark /><span>{copy.brandName}<span className="brand-divider" /> <span className="brand-product">{copy.brandProduct}</span></span></a>
        <Button type="text" className="help-button" icon={<CustomerServiceOutlined />} onClick={() => setModal('help')}>{copy.help} <span className="help-arrow">↗</span></Button>
      </header>
      <main className="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-intro">
            <div className="eyebrow"><span className="accent-line" /> {copy.heroEyebrow}</div>
            <h1 id="hero-title">{copy.heroTitle}<br /><span>{copy.heroTitleAccent}</span></h1>
            <p className="hero-description">{copy.heroDescription}</p>
          </div>
          <div className="sphere-scene">
            <AgentSphere />
            <span className="scene-label label-left" aria-hidden="true"><i /> {copy.sceneUnderstand}</span>
            <span className="scene-label label-right" aria-hidden="true">{copy.sceneConnect} <i /></span>
            <span className="scene-axis" aria-hidden="true">+<span>{copy.sceneCore}</span>+</span>
          </div>
          <div className="example-area">
            <div className="example-prompt" key={example}><span className="mini-star">✧</span><span>{examples[example].prompt}</span><span className="prompt-arrow"><ArrowUpOutlined /></span></div>
            <div className="example-tabs" aria-label={copy.examplesLabel}>
              {examples.map((item, i) => <Button key={item.label} type="text" aria-pressed={example === i} className={example === i ? 'example-tab selected' : 'example-tab'} onClick={() => setExample(i)}>{item.label}</Button>)}
            </div>
            <p className="example-caption" aria-live="polite">{examples[example].caption}</p>
          </div>
        </section>
        <section className="login-section" aria-labelledby="login-title">
          <div className="login-box">
            <div className="login-symbol"><Mark /></div>
            <div className="login-eyebrow">{copy.loginEyebrow}</div>
            <h2 id="login-title">{copy.loginTitle}</h2>
            <p className="login-description">{copy.loginDescription}</p>
            {error && <Alert type="error" showIcon message={error} role="alert" />}
            {session ? <div className="login-form">
              <p>{copy.signedIn}</p>
              <Button type="primary" block onClick={() => window.location.replace('/')} disabled={loading}>{copy.continueWorkspace}</Button>
              <Button type="text" block onClick={logout} loading={loading}>{copy.logout}</Button>
            </div> : <Form form={form} layout="vertical" className="login-form" onFinish={submit} requiredMark={false} autoComplete="on" disabled={loading || checkingSession}>
              <Form.Item name="account" label={copy.accountLabel} rules={[{ required: true, whitespace: true, message: copy.accountRequired }]}>
                <Input prefix={<UserOutlined />} placeholder={copy.accountPlaceholder} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} aria-label={copy.accountLabel} />
              </Form.Item>
              <Form.Item name="password" label={copy.passwordLabel} rules={[{ required: true, message: copy.passwordRequired }]}>
                <Input.Password prefix={<LockOutlined />} placeholder={copy.passwordPlaceholder} autoComplete="current-password" maxLength={1024} aria-label={copy.passwordLabel} onKeyUp={e => setCapsLock(e.getModifierState('CapsLock'))} onKeyDown={e => setCapsLock(e.getModifierState('CapsLock'))} onBlur={() => setCapsLock(false)} />
              </Form.Item>
              <div className="form-assistance"><span className={capsLock ? 'caps-alert' : 'account-hint'}>{capsLock ? copy.capsLock : copy.accountHint}</span><Button type="link" onClick={() => setModal('help')}>{copy.forgotPassword}</Button></div>
              <Button type="primary" htmlType="submit" block loading={loading || checkingSession} className="login-submit"><span>{checkingSession ? copy.checkingSession : loading ? copy.submitting : copy.submit}</span>{!loading && !checkingSession && <ArrowRightOutlined />}</Button>
            </Form>}
            <div className="login-divider"><span /> <SafetyCertificateOutlined /> <span /></div>
            <p className="access-note">{copy.noAccount}<Button type="link" onClick={() => setModal('help')}>{copy.contactAdmin} <span aria-hidden="true">↗</span></Button></p>
            <div className="login-footnote"><span className="tiny-dot" /> {copy.loginFootnote}</div>
          </div>
        </section>
      </main>
      <footer className="footer"><span>© {new Date().getFullYear()} {copy.copyrightBrand}</span><span className="footer-center">{copy.footerCaption}</span><Button type="text" onClick={() => setModal('privacy')}>{copy.privacy} <span>↗</span></Button></footer>
      <Modal open={modal !== null} title={modalContent[modal]?.title} onCancel={() => setModal(null)} footer={<Button type="primary" onClick={() => setModal(null)}>{copy.dismissModal}</Button>} centered width={440}><p className="modal-copy">{modalContent[modal]?.text}</p></Modal>
    </div>
  </ConfigProvider>;
}

createRoot(document.getElementById('root')).render(<App />);
