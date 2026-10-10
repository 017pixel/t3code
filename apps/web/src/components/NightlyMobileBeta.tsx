import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { AndroidIcon, AppleIcon } from "./Icons";
import { NIGHTLY_MOBILE_BETA_ROW_ID } from "./NightlyMobileBetaNotice";
import { SettingsRow } from "./settings/settingsLayout";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { QRCodeSvg } from "./ui/qr-code";

// The Nightly beta app links. See NightlyMobileBetaNotice.tsx; both go away
// when the store apps move to V2.
const IOS_TESTFLIGHT_URL = "https://testflight.apple.com/join/XgaxaRtd";
const ANDROID_BETA_GROUP_URL = "https://groups.google.com/g/t3-code-v2-beta";
const ANDROID_PLAY_TESTING_URL = "https://play.google.com/apps/testing/com.t3tools.t3code";

/** QR code plus a copy button for one beta link. */
function BetaLinkQr({ url, label }: { url: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="rounded-lg bg-white p-1.5">
        <QRCodeSvg value={url} size={128} level="M" marginSize={1} title={label} />
      </div>
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(url)}>
        {isCopied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

/** Settings → General → About row with the beta app links. Render it only for Nightly. */
export function NightlyMobileBetaRow() {
  return (
    <SettingsRow
      id={NIGHTLY_MOBILE_BETA_ROW_ID}
      title="Mobile app"
      description="Nightly needs the beta app. The App Store and Google Play versions cannot connect."
      control={
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger render={<Button size="sm" variant="outline" />}>
              <AppleIcon />
              iPhone
            </PopoverTrigger>
            <PopoverPopup align="end">
              <div className="flex flex-col gap-3">
                <div className="space-y-1">
                  <PopoverTitle>TestFlight beta</PopoverTitle>
                  <p className="text-xs text-muted-foreground">Scan with your iPhone camera.</p>
                </div>
                <BetaLinkQr url={IOS_TESTFLIGHT_URL} label="TestFlight beta link" />
              </div>
            </PopoverPopup>
          </Popover>
          <Popover>
            <PopoverTrigger render={<Button size="sm" variant="outline" />}>
              <AndroidIcon />
              Android
            </PopoverTrigger>
            <PopoverPopup align="end">
              <div className="flex flex-col gap-3">
                <div className="space-y-1">
                  <PopoverTitle>Google Play beta</PopoverTitle>
                  <p className="max-w-72 text-xs text-muted-foreground">
                    Use the same Google account for both steps. Step 2 can take up to an hour to
                    work after you join the group.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <p className="text-center text-xs font-medium">1. Join the group</p>
                    <BetaLinkQr url={ANDROID_BETA_GROUP_URL} label="Android beta group link" />
                  </div>
                  <div className="space-y-2">
                    <p className="text-center text-xs font-medium">2. Become a tester</p>
                    <BetaLinkQr url={ANDROID_PLAY_TESTING_URL} label="Google Play beta link" />
                  </div>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      }
    />
  );
}
