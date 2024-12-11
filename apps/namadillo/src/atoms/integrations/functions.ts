import { Asset, AssetList, Chain, IBCInfo } from "@chain-registry/types";
import { QueryClient, setupIbcExtension } from "@cosmjs/stargate";
import { Tendermint34Client } from "@cosmjs/tendermint-rpc";
import { Account, IbcTransferProps } from "@namada/types";
import { mapUndefined, shortenAddress } from "@namada/utils";
import BigNumber from "bignumber.js";
import * as celestia from "chain-registry/mainnet/celestia";
import * as cosmos from "chain-registry/mainnet/cosmoshub";
import * as dydx from "chain-registry/mainnet/dydx";
import * as osmosis from "chain-registry/mainnet/osmosis";
import * as stargaze from "chain-registry/mainnet/stargaze";
import * as celestiaTestnet from "chain-registry/testnet/celestiatestnet3";
import * as cosmosTestnet from "chain-registry/testnet/cosmosicsprovidertestnet";
import * as dydxTestnet from "chain-registry/testnet/dydxtestnet";
import * as elysTestnet from "chain-registry/testnet/elystestnet";
import * as osmosisTestnet from "chain-registry/testnet/osmosistestnet";
import * as stargazeTestnet from "chain-registry/testnet/stargazetestnet";
import { DenomTrace } from "cosmjs-types/ibc/applications/transfer/v1/transfer";
import { TransactionPair, buildTxPair } from "lib/query";
import {
  AddressWithAsset,
  AddressWithAssetAndAmount,
  AddressWithAssetAndAmountMap,
  ChainRegistryEntry,
  ChainSettings,
  Coin,
  GasConfig,
  LocalnetToml,
} from "types";
import { toBaseAmount, toDisplayAmount } from "utils";
import { getSdkInstance } from "utils/sdk";

import housefireAssets from "namada-chain-registry/_testnets/namadahousefire/assetlist.json";
import housefireChain from "namada-chain-registry/_testnets/namadahousefire/chain.json";
import internalDevnetAssets from "namada-chain-registry/_testnets/namadainternaldevnet/assetlist.json";
import internalDevnetChain from "namada-chain-registry/_testnets/namadainternaldevnet/chain.json";
import namadaAssets from "namada-chain-registry/namada/assetlist.json";
import namadaChain from "namada-chain-registry/namada/chain.json";

import housefireCosmosTestnetIbc from "namada-chain-registry/_testnets/_IBC/namadahousefire-cosmoshubtestnet.json";
import housefireOsmosisTestnetIbc from "namada-chain-registry/_testnets/_IBC/namadahousefire-osmosistestnet.json";
import internalDevnetCosmosTestnetIbc from "namada-chain-registry/_testnets/_IBC/namadainternaldevnet-cosmoshubtestnet.json";

// TODO: this causes a big increase on bundle size. See #1224.
import cosmosRegistry from "chain-registry";

cosmosRegistry.chains.push(internalDevnetChain, housefireChain, namadaChain);

cosmosRegistry.assets.push(internalDevnetAssets, housefireAssets, namadaAssets);

cosmosRegistry.ibc.push(
  internalDevnetCosmosTestnetIbc,
  housefireCosmosTestnetIbc,
  housefireOsmosisTestnetIbc
);

const mainnetChains: ChainRegistryEntry[] = [
  celestia,
  cosmos,
  dydx,
  osmosis,
  stargaze,
];

const testnetChains: ChainRegistryEntry[] = [
  cosmosTestnet,
  celestiaTestnet,
  dydxTestnet,
  osmosisTestnet,
  stargazeTestnet,
  // TODO: Temporarily added as it has a live relayer to theta-testnet-001
  elysTestnet,
];

const mainnetAndTestnetChains = [...mainnetChains, ...testnetChains];

export const getKnownChains = (
  includeTestnets?: boolean
): ChainRegistryEntry[] => {
  return includeTestnets ? mainnetAndTestnetChains : mainnetChains;
};

export const ibcAddressToDenomTrace =
  (rpc: string) =>
  async (address: string): Promise<DenomTrace | undefined> => {
    if (!address.startsWith("ibc/")) {
      return undefined;
    }

    const tmClient = await Tendermint34Client.connect(rpc);
    const queryClient = new QueryClient(tmClient);
    const ibcExtension = setupIbcExtension(queryClient);
    const ibcHash = address.replace("ibc/", "");

    const { denomTrace } = await ibcExtension.ibc.transfer.denomTrace(ibcHash);

    if (typeof denomTrace === "undefined") {
      throw new Error("Couldn't get denom trace from IBC address");
    }

    return denomTrace;
  };

const assetLookup = (chainName: string): Asset[] | undefined =>
  cosmosRegistry.assets.find((chain) => chain.chain_name === chainName)?.assets;

const tryDenomToRegistryAsset = (
  denom: string,
  registryAssets: Asset[]
): Asset | undefined =>
  registryAssets.find((asset) => {
    const { base, address } = asset;
    const aliases =
      asset.denom_units.find((denomUnit) => denomUnit.denom === base)
        ?.aliases || [];

    return [base, address, ...aliases].includes(denom);
  });

// For a given chain name with a given IBC channel, look up the counterpart
// chain name that the channel corresponds to.
// For example, transfer/channel-16 on elystestnet corresponds to
// cosmoshubtestnet.
const findCounterpartChainName = (
  chainName: string,
  portId: string,
  channelId: string
): string | undefined => {
  return cosmosRegistry.ibc.reduce<string | undefined>((acc, curr) => {
    if (typeof acc !== "undefined") {
      return acc;
    }

    const tryFindSourceChainName = (
      ourChainNumber: "chain_1" | "chain_2"
    ): string | undefined => {
      if (curr[ourChainNumber].chain_name === chainName) {
        const match = curr.channels.some((channelEntry) => {
          const { port_id, channel_id } = channelEntry[ourChainNumber];
          return port_id === portId && channel_id === channelId;
        });

        if (match) {
          const theirChainNumber =
            ourChainNumber === "chain_1" ? "chain_2" : "chain_1";

          return curr[theirChainNumber].chain_name;
        }
      }
      return undefined;
    };

    return (
      tryFindSourceChainName("chain_1") || tryFindSourceChainName("chain_2")
    );
  }, undefined);
};

const tryDenomToIbcAsset = async (
  denom: string,
  ibcAddressToDenomTrace: (address: string) => Promise<DenomTrace | undefined>,
  chainName: string
): Promise<Asset | undefined> => {
  const denomTrace = await ibcAddressToDenomTrace(denom);
  if (typeof denomTrace === "undefined") {
    return undefined;
  }

  const { path, baseDenom } = denomTrace;

  const assetOnRegistry = tryDenomToRegistryAsset(
    baseDenom,
    cosmosRegistry.assets.map((assetListEl) => assetListEl.assets).flat()
  );

  if (assetOnRegistry) {
    return assetOnRegistry;
  }

  // denom trace path may be something like...
  // transfer/channel-16/transfer/channel-4353
  // ...so from here walk the path to find the original chain
  const pathParts = path.split("/");
  if (pathParts.length % 2 !== 0) {
    return undefined;
  }

  const ibcChannelTrail: { portId: string; channelId: string }[] = [];
  for (let i = 0; i < pathParts.length; i += 2) {
    ibcChannelTrail.push({
      portId: pathParts[i],
      channelId: pathParts[i + 1],
    });
  }

  const originalChainName = ibcChannelTrail.reduce<string | undefined>(
    (currentChainName, { portId, channelId }) => {
      if (typeof currentChainName === "undefined") {
        return undefined;
      }

      return findCounterpartChainName(currentChainName, portId, channelId);
    },
    chainName
  );

  const originalChainAssets = mapUndefined(assetLookup, originalChainName);

  const originalChainRegistryAsset =
    originalChainAssets &&
    tryDenomToRegistryAsset(baseDenom, originalChainAssets);

  return originalChainRegistryAsset || unknownAsset(path + "/" + baseDenom);
};

const unknownAsset = (denom: string): Asset => ({
  denom_units: [
    {
      denom,
      exponent: 0,
    },
  ],
  base: denom,
  name: denom,
  display: denom,
  symbol: shortenAddress(denom, 4, 4),
});

const findOriginalAsset = async (
  coin: Coin,
  assets: Asset[],
  ibcAddressToDenomTrace: (address: string) => Promise<DenomTrace | undefined>,
  chainName?: string
): Promise<AddressWithAssetAndAmount> => {
  const { minDenomAmount, denom } = coin;
  let asset;

  if (assets) {
    asset = tryDenomToRegistryAsset(denom, assets);
  }

  if (!asset && chainName) {
    asset = await tryDenomToIbcAsset(denom, ibcAddressToDenomTrace, chainName);
  }

  if (!asset) {
    asset = unknownAsset(denom);
  }

  const baseBalance = BigNumber(minDenomAmount);
  if (baseBalance.isNaN()) {
    throw new Error(`Invalid balance: ${minDenomAmount}`);
  }

  const displayBalance = toDisplayAmount(asset, baseBalance);
  return {
    originalAddress: denom,
    amount: displayBalance,
    asset,
  };
};

const findChainById = (chainId: string): Chain | undefined => {
  return cosmosRegistry.chains.find((chain) => chain.chain_id === chainId);
};

export const mapCoinsToAssets = async (
  coins: Coin[],
  chainId: string,
  ibcAddressToDenomTrace: (address: string) => Promise<DenomTrace | undefined>
): Promise<AddressWithAssetAndAmountMap> => {
  const chainName = findChainById(chainId)?.chain_name;
  const assets = mapUndefined(assetLookup, chainName);
  const results = await Promise.allSettled(
    coins.map(
      async (coin) =>
        await findOriginalAsset(
          coin,
          assets || [],
          ibcAddressToDenomTrace,
          chainName
        )
    )
  );

  const successfulResults = results.reduce<AddressWithAssetAndAmount[]>(
    (acc, curr) => (curr.status === "fulfilled" ? [...acc, curr.value] : acc),
    []
  );

  return Object.fromEntries(
    successfulResults.map((asset) => [asset.originalAddress, asset])
  );
};

export const getRpcByIndex = (chain: Chain, index = 0): string => {
  const availableRpcs = chain.apis?.rpc;
  if (!availableRpcs) {
    throw new Error("There are no available RPCs for " + chain.chain_name);
  }
  const randomRpc = availableRpcs[Math.min(index, availableRpcs.length - 1)];
  return randomRpc.address;
};

export const getRestApiAddressByIndex = (chain: Chain, index = 0): string => {
  const availableRestApis = chain.apis?.rest;
  if (!availableRestApis) {
    throw new Error("There are no available Rest APIs for " + chain.chain_name);
  }
  const randomRestApi =
    availableRestApis[Math.min(index, availableRestApis.length - 1)];
  return randomRestApi.address;
};

export type IbcChannels = {
  namadaChannelId: string;
  cosmosChannelId: string;
};

export const getIbcChannels = (
  namadaChainId: string,
  cosmosChainName: string
): IbcChannels | undefined => {
  const namadaChainName = cosmosRegistry.chains.find(
    (chain) => chain.chain_id === namadaChainId
  )?.chain_name;

  if (typeof namadaChainName === "undefined") {
    return undefined;
  }

  for (const ibcEntry of cosmosRegistry.ibc) {
    const { chain_1, chain_2, channels } = ibcEntry;
    const channelEntry = channels[0];

    if (typeof channelEntry === "undefined") {
      continue;
    }

    if (
      chain_1.chain_name === namadaChainName &&
      chain_2.chain_name === cosmosChainName
    ) {
      return {
        namadaChannelId: channelEntry.chain_1.channel_id,
        cosmosChannelId: channelEntry.chain_2.channel_id,
      };
    }

    if (
      chain_1.chain_name === cosmosChainName &&
      chain_2.chain_name === namadaChainName
    ) {
      return {
        cosmosChannelId: channelEntry.chain_1.channel_id,
        namadaChannelId: channelEntry.chain_2.channel_id,
      };
    }
  }
};

export const createIbcTx = async (
  account: Account,
  destinationAddress: string,
  token: AddressWithAsset,
  amount: BigNumber,
  portId: string,
  channelId: string,
  gasConfig: GasConfig,
  chain: ChainSettings,
  memo?: string
): Promise<TransactionPair<IbcTransferProps>> => {
  const { tx } = await getSdkInstance();

  // SDK expects IBC amounts in base denom
  const amountInBaseDenom = toBaseAmount(token.asset, amount);

  const ibcTransferProps = {
    source: account.address,
    receiver: destinationAddress,
    token: token.originalAddress,
    amountInBaseDenom,
    portId,
    channelId,
    memo,
  };

  const transactionPair = await buildTxPair(
    account,
    gasConfig,
    chain,
    [ibcTransferProps],
    tx.buildIbcTransfer,
    account.address
  );
  return transactionPair;
};

export const namadaLocal = (chainId: string): Chain => ({
  ...internalDevnetChain,
  chain_name: "localnet",
  chain_id: chainId,
});

export const namadaLocalAsset = (tokenAddress: string): AssetList => ({
  ...internalDevnetAssets,
  chain_name: "localnet",
  assets: internalDevnetAssets.assets.map((asset) =>
    asset.symbol === "NAM" ?
      {
        ...asset,
        address: tokenAddress,
      }
    : asset
  ),
});

export const namadaLocalRelayer = (
  chain1Channel: string,
  chain2Channel: string
): IBCInfo => ({
  ...internalDevnetCosmosTestnetIbc,
  chain_1: {
    ...internalDevnetCosmosTestnetIbc.chain_1,
    chain_name: "localnet",
  },
  chain_2: {
    ...internalDevnetCosmosTestnetIbc.chain_2,
    chain_name: "cosmosicsprovidertestnet",
  },
  channels: [
    {
      ...internalDevnetCosmosTestnetIbc.channels[0],
      chain_1: {
        ...internalDevnetCosmosTestnetIbc.channels[0].chain_1,
        channel_id: chain1Channel,
      },
      chain_2: {
        ...internalDevnetCosmosTestnetIbc.channels[0].chain_2,
        channel_id: chain2Channel,
      },
    },
  ],
});

export const addLocalnetToRegistry = (config: LocalnetToml): void => {
  const { chain_id, token_address, chain_1_channel, chain_2_channel } = config;

  const localChain: ChainRegistryEntry = {
    chain: namadaLocal(chain_id),
    assets: namadaLocalAsset(token_address),
    ibc: [namadaLocalRelayer(chain_1_channel, chain_2_channel)],
  };

  cosmosRegistry.chains.push(localChain.chain);
  cosmosRegistry.assets.push(localChain.assets);
  cosmosRegistry.ibc.push(...localChain.ibc!);

  mainnetChains.push(localChain);
};
