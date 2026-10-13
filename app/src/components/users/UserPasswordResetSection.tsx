'use client'

import { useState } from 'react'
import { Eye, EyeOff, KeyRound, Loader2, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { useSaCapabilityCheck } from '@/hooks/useSaCapability'
import { InfoPopover } from '@/components/security-access/ui'
import { USER_PASSWORD_RESET_PERMISSION } from '@/lib/security-access/user-admin-catalog'

interface UserPasswordResetSectionProps {
  targetUserId: string
  targetUserName: string
  targetUserEmail: string
  currentUserRoleLevel: number
  /** The target's organization: the same one the server judges the reset in (never the administrator's own). */
  targetOrganizationId?: string | null
}

export default function UserPasswordResetSection({
  targetUserId,
  targetUserName,
  targetUserEmail,
  currentUserRoleLevel,
  targetOrganizationId = null,
}: UserPasswordResetSectionProps) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The same decision the server takes: platform.user.password_reset in the TARGET's organization; until it is enforced, the
  // legacy rule (exact role level 10). Editing profiles never shows this button. The server still decides on submit.
  // A check that could not complete is shown as such (with Retry), never as a silent denial or a guessed permission.
  const check = useSaCapabilityCheck(USER_PASSWORD_RESET_PERMISSION, currentUserRoleLevel === 10, targetOrganizationId)
  if (check.status === 'denied') return null

  const passwordTooShort = newPassword.length > 0 && newPassword.length < 8
  const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword
  const canSubmit = newPassword.length >= 8 && newPassword === confirmPassword && !submitting

  const resetForm = () => {
    setNewPassword('')
    setConfirmPassword('')
    setShowNewPassword(false)
    setShowConfirmPassword(false)
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (submitting) return
    setOpen(next)
    if (!next) resetForm()
  }

  const handleReset = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch('/api/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: targetUserId, new_password: newPassword }),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || !result?.success) throw new Error(result?.error || 'Failed to reset password.')

      toast({ title: 'Password reset', description: `Password reset successfully for ${targetUserName}.` })
      setOpen(false)
      resetForm()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to reset password.'
      setError(message)
      toast({ title: 'Password reset failed', description: message, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2" aria-labelledby="account-security-heading">
        <div className="flex items-center gap-1.5">
          <h3 id="account-security-heading" className="text-sm font-semibold text-gray-950">Account security</h3>
          <InfoPopover label="About resetting a password">
            <p>Sets a new login password for this account. It is a separate action: it takes effect immediately and does not save any other change on this form.</p>
            <p>Resetting needs its own permission (Reset User Password); editing profiles does not include it. Separate from Group Policy assignment and from a person changing their own password.</p>
          </InfoPopover>
        </div>
        {check.status === 'allowed' ? (
          <Button type="button" variant="outline" size="sm" className="h-8 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => setOpen(true)}>
            <KeyRound className="mr-1.5 h-3.5 w-3.5" />
            Reset password
          </Button>
        ) : check.status === 'checking' ? (
          <p role="status" className="inline-flex items-center gap-1.5 text-xs text-gray-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Checking password reset permission…
          </p>
        ) : (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-800">
            <span>Couldn’t check whether you can reset this password. This is not a denial.</span>
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={check.retry}>
              <RefreshCw className="mr-1.5 h-3 w-3" aria-hidden />
              Retry
            </Button>
          </div>
        )}
      </section>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="z-[120] sm:max-w-md"
          overlayClassName="password-reset-overlay z-[110]"
          data-testid="password-reset-modal"
        >
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new password for {targetUserName} ({targetUserEmail}).
            </DialogDescription>
          </DialogHeader>

          <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            This is a separate action and takes effect as soon as you confirm. It does not save other changes on the Edit User form, and cancelling that form later does not undo it. The password is never shown again.
          </p>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="reset-new-password">New Password</Label>
              <div className="relative">
                <Input
                  id="reset-new-password"
                  type={showNewPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  minLength={8}
                  autoComplete="new-password"
                  className="pr-10"
                  disabled={submitting}
                />
                <button
                  type="button"
                  aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500"
                  onClick={() => setShowNewPassword((value) => !value)}
                >
                  {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className={`text-xs ${passwordTooShort ? 'text-red-600' : 'text-gray-500'}`}>Minimum 8 characters</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reset-confirm-password">Confirm New Password</Label>
              <div className="relative">
                <Input
                  id="reset-confirm-password"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  className="pr-10"
                  disabled={submitting}
                />
                <button
                  type="button"
                  aria-label={showConfirmPassword ? 'Hide confirmed password' : 'Show confirmed password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500"
                  onClick={() => setShowConfirmPassword((value) => !value)}
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {passwordsMismatch ? <p className="text-xs text-red-600">Passwords do not match.</p> : null}
            </div>
          </div>

          {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={handleReset} disabled={!canSubmit}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {submitting ? 'Resetting…' : 'Reset password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
