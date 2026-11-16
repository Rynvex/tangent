import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  IconButton,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  ShortcutsProvider,
  Skeleton,
  StatusBanner,
  Tab,
  Tabs,
  TabsList,
  TabsPanel,
  TangentRoot,
  TextArea,
  TextField,
  UsageMeter,
} from "@tangent/react";
import { Settings } from "lucide-react";
import type { DemoParams } from "./frame/params";
import { BranchSamples } from "./gallery-branch";
import { ConversationSamples } from "./gallery-conversation";

const THRESHOLDS = [
  { value: "0.02", label: "US$0.02" },
  { value: "0.05", label: "US$0.05" },
  { value: "0.10", label: "US$0.10" },
] as const;

/**
 * Every @tangent/react base component on one page (`?view=gallery`), so the
 * e2e axe run can open each popup and check it in a real browser and theme.
 * Not part of the product; the text is fixed demo copy.
 */
export function Gallery({ params }: { params: DemoParams }) {
  return (
    <TangentRoot theme={params.theme} className="h-full overflow-auto">
      <ShortcutsProvider>
        <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
          <h1 className="m-0 text-tg-xl font-semibold text-tg-foreground-strong">元件總覽</h1>
          <StatusBanner state={{ kind: "limit", limit: 200 }} />
          <section aria-label="按鈕" className="flex flex-wrap items-center gap-2">
            <Button variant="primary">全部接受並帶回</Button>
            <Button>依勾選帶回</Button>
            <Button variant="ghost">取消</Button>
            <Button variant="destructive">不帶回</Button>
            <Button loading>起草</Button>
            <IconButton label="設定" icon={<Settings />} />
            <Badge tone="warning">6</Badge>
            <Kbd>⌘ K</Kbd>
            <UsageMeter usage={{ inputTokens: 33_100, outputTokens: 5_200, costUsd: 0.21 }} onClick={() => undefined} />
          </section>
          <section aria-label="表單" className="flex flex-col gap-4">
            <TextField label="目的" description="一句話說明這條支線要弄清楚什麼" placeholder="例如：ZFS 與 Btrfs 的差異" />
            <TextArea label="結論" error="結論空白不能帶回" />
            <Select label="費用提示門檻" options={THRESHOLDS} defaultValue="0.05" />
            <Checkbox defaultChecked>帶入分岔後主線的內容</Checkbox>
          </section>
          <section aria-label="浮層" className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger render={<Button>開支線</Button>} />
              <DialogContent title="開支線" description="從這則訊息岔出去" footer={<DialogClose render={<Button variant="primary">建立</Button>} />}>
                <TextField label="目的" />
              </DialogContent>
            </Dialog>
            <Menu>
              <MenuTrigger render={<Button>訊息動作</Button>} />
              <MenuContent>
                <MenuItem>複製</MenuItem>
                <MenuItem>開支線</MenuItem>
                <MenuSeparator />
                <MenuItem destructive>刪除</MenuItem>
              </MenuContent>
            </Menu>
            <Popover>
              <PopoverTrigger render={<Button>預覽分岔點</Button>} />
              <PopoverContent title="分岔點">
                <p className="m-0">主線 #18：預算內買 4 顆碟做 RAIDZ1 好了。</p>
              </PopoverContent>
            </Popover>
          </section>
          <ConversationSamples />
          <BranchSamples />
          <Tabs defaultValue="structure">
            <TabsList aria-label="側欄">
              <Tab value="structure">結構</Tab>
              <Tab value="notes">紀要</Tab>
            </TabsList>
            <TabsPanel value="structure">
              <Skeleton className="mt-3 h-4 w-2/3" />
            </TabsPanel>
            <TabsPanel value="notes">紀要內容</TabsPanel>
          </Tabs>
        </main>
      </ShortcutsProvider>
    </TangentRoot>
  );
}
