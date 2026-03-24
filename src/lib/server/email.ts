import { Resend } from 'resend';
import { env } from '$env/dynamic/private';

export async function sendOTPEmail(to: string, code: string): Promise<{ ok: boolean; detail?: string }> {
	const apiKey = env.RESEND_API_KEY;
	if (!apiKey) {
		console.log(`[DEV] OTP for ${to}: ${code}`);
		return { ok: true };
	}

	const resend = new Resend(apiKey);
	const { error } = await resend.emails.send({
		from: env.EMAIL_FROM ?? 'MSV Hub <onboarding@resend.dev>',
		to,
		subject: 'MSV Hub — Your Login Code',
		html: `
			<div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
				<h2 style="color: #6d28d9;">MSV Hub</h2>
				<p>Your one-time login code is:</p>
				<div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; background: #f5f3ff; border-radius: 8px; color: #6d28d9;">
					${code}
				</div>
				<p style="color: #666; font-size: 14px; margin-top: 16px;">This code expires in 10 minutes.</p>
			</div>
		`
	});

	if (error) {
		console.error('Failed to send OTP email:', error);
		return { ok: false, detail: error.message };
	}
	return { ok: true };
}
