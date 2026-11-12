"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { MarketPoint } from "@/lib/market-types";

interface MarketPriceChartProps {
  color: string;
  data: MarketPoint[];
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: MarketPoint }>;
}) {
  if (!active || !payload?.[0]) return null;
  const point = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <span>{point.label}</span>
      <strong>{formatPrice(point.price)}</strong>
      <small>{formatCompact(point.volume)} volume</small>
    </div>
  );
}

export default function MarketPriceChart({ color, data }: MarketPriceChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.24} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#172331" strokeDasharray="2 5" vertical={false} />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{ fill: "#677688", fontSize: 10 }}
          minTickGap={28}
        />
        <YAxis
          orientation="right"
          axisLine={false}
          tickLine={false}
          tick={{ fill: "#677688", fontSize: 10 }}
          domain={["dataMin - 2", "dataMax + 2"]}
          tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
          width={48}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#3a4b5f" }} />
        <Area
          type="monotone"
          dataKey="price"
          stroke={color}
          strokeWidth={2}
          fill="url(#priceFill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
