import hre from "hardhat";
import BN, {BigNumber} from "bignumber.js";
import chai, {assert, expect} from "chai";
import {DurationInputArg1, DurationInputArg2} from "moment";
import moment from "moment/moment";
import {ERC20, OrderBook} from "../typechain";
import {
    Addressable,
    AddressLike,
    BigNumberish,
    type ContractTransactionResponse,
    ethers,
    TransactionResponse
} from "ethers";
import {Provider} from "zksync-ethers";
import {loadFixture, time} from "@nomicfoundation/hardhat-network-helpers";
import chaiBN from 'chai-bignumber';

BigNumber.config({EXPONENTIAL_AT: 1e+9});
chai.use(chaiBN());

export enum OrderSide {
    BUY = 0,
    SELL = 1,
}

export enum OrderCloseReason {
    FILLED = 0, CANCELLED, EXPIRED, OUT_OF_BALANCE, OUT_OF_ALLOWANCE
}

enum TimeInForce {
    GTC = 0, IOK, FOK
}

async function deployContract<T extends ethers.BaseContract>(owner: any, contractName: string, args: any[] = []): Promise<T> {
    if (hre.network.zksync) {
        hre.deployer.setWallet(owner);

        const etaGas = await hre.deployer.estimateDeployGas(await hre.deployer.loadArtifact(contractName), args);
        console.log(`ETA deploy ${contractName} cost ${etaGas} gas`);
        return (await hre.deployer.deploy(contractName, args)) as any;
    } else {
        return (await hre.ethers.deployContract(contractName, args, owner)) as any;
    }
}

export async function deployFakeTokens(owner: any) {
    const WETH = await deployContract<ERC20>(owner, "WETH");
    const USDC = await deployContract<ERC20>(owner, "USDC");
    return {
        WETH, USDC
    };
}

export async function setUpTest() {
    if (hre.network.zksync) return _setUpTest();
    return loadFixture(_setUpTest);
}

async function _setUpTest() {
    let [alice, bob, admin] = hre.network.zksync
        ? await hre.zksyncEthers.getWallets()
        : await hre.ethers.getSigners();

    if (hre.network.zksync) {
        const provider = new Provider((hre.network.config as any).url, undefined, {cacheTimeout: -1});
        alice = alice.connect(provider) as any;
        bob = bob.connect(provider) as any;
        admin = admin.connect(provider) as any;
    }

    const {WETH, USDC} = await deployFakeTokens(admin);
    const ethDecimalPow = `1e${Number(await WETH.decimals())}`;
    const usdcDecimalPow = `1e${Number(await USDC.decimals())}`;
    await WETH.transfer(bob.address, new BN(1000).times(ethDecimalPow).dp(0).toString());
    await USDC.transfer(bob.address, new BN(150000).times(usdcDecimalPow).dp(0).toString());

    //deploy contract
    const takerFeeBps = 0.1 / 0.01; // 0.1% = 10 basis points
    const makerFeeBps = 0.1 / 0.01; // 0.1% = 10 basis points
    const priceDecimals = 20;
    const minQuote = new BN(5).times(usdcDecimalPow).toString(); // 5 USDC
    const orderBookConstructorArgs = [admin.address];
    const OrderBookContract = await deployContract<OrderBook>(admin, "OrderBook", orderBookConstructorArgs);
    const wethAddress = await WETH.getAddress();
    const usdcAddress = await USDC.getAddress();
    let defaultPairId = 0n;
    await expect(
        OrderBookContract.connect(admin)
            .createPair(
                wethAddress, usdcAddress,
                priceDecimals, minQuote, minQuote, takerFeeBps, makerFeeBps
            )
    ).to.emit(OrderBookContract, "NewPairConfigEvent")
        .withArgs(
            wethAddress, usdcAddress, minQuote, minQuote,
            (id: bigint) => {
                defaultPairId = id;
                return true;
            },
            takerFeeBps, makerFeeBps, priceDecimals, true
        );
    expect(defaultPairId).gt(0);

    const priceDecimalPow = `1e${priceDecimals}`;
    return {
        alice, bob, admin, WETH, USDC, wethAddress, usdcAddress,
        OrderBookContract, defaultPairId,
        takerFeeBps, makerFeeBps, minQuote,
        usdcDecimalPow, ethDecimalPow, priceDecimalPow,
        fmtUsdc: (value: BN.Value) => new BN(value).times(usdcDecimalPow).toString(),
        fmtWeth: (value: BN.Value) => new BN(value).times(ethDecimalPow).toString(),
        fmtPrice: (price: BN.Value) => new BN(price).times(usdcDecimalPow).times(priceDecimalPow)
            .div(ethDecimalPow).toString(),
        expireAfter: async (amount: DurationInputArg1, unit: DurationInputArg2) =>
            moment.unix(await currentBlockTime()).add(amount, unit).unix(),
        approveSpending: async (token: ERC20, owner: ethers.Signer, amount: BigNumberish) =>
            token.connect(owner).approve(await OrderBookContract.getAddress(), amount)
    };
}

export const submitOrderHelper = async (
    contract: OrderBook, owner: ethers.Signer, pairId: BigNumberish,
    side: OrderSide, price: BigNumberish, amount: BigNumberish,
    validUtil?: BigNumberish | Promise<BigNumberish>,
    tif?: TimeInForce,
    orderIdsToFill?: BigNumberish[],
    extraExpect?: (tx: Promise<ContractTransactionResponse>) => Promise<void>
): Promise<bigint> => {
    // validUtil = validUtil ?? moment().add(1, 'day').unix();
    const _validUtil = validUtil
        ? await validUtil
        : moment.unix(await currentBlockTime()).add(1, 'day').unix();
    let orderId = 0n;
    const tx = contract.connect(owner)
        .submitOrder(side, price, amount, pairId, _validUtil, tif ?? TimeInForce.GTC, orderIdsToFill ?? []);
    await expect(tx).to.emit(contract, "NewOrderEvent")
        .withArgs(
            (_orderId: bigint) => {
                orderId = _orderId;
                return true;
            },
            owner, price, amount, pairId, side, _validUtil
        );
    if (extraExpect) {
        await extraExpect(tx);
    }
    expect(orderId).gt(0);
    return orderId;
};

export function getZkTestProvider(): Provider {
    return new Provider((hre.network.config as any).url);
}

export async function currentBlockTime(): Promise<number> {
    return hre.network.zksync
        ? getZkTestProvider().send("config_getCurrentTimestamp", [])
        : await time.latest();
}

export async function expectTokenChangeBalance(
    tx: TransactionResponse | Promise<TransactionResponse>,
    token: ERC20, accounts: AddressLike[], changes: BN[]
) {
    if (hre.network.zksync) {
        const receipt = await (await tx).wait();
        assert(receipt != null);
        const actualChanges: any = {};
        const eventFragment = token.interface.getEvent("Transfer");
        const transferTopicHash = eventFragment.topicHash;
        for (let i = 0; i < receipt.logs.length; i++) {
            const log = receipt.logs[i];
            if (log.address == await token.getAddress() && log.topics[0] === transferTopicHash) {
                const transferEvent = token.interface.decodeEventLog(eventFragment, log.data, log.topics);
                const from = transferEvent.from;
                const to = transferEvent.to;
                const value = new BN(transferEvent.value);
                actualChanges[from] = (actualChanges[from] ?? new BN(0)).minus(value);
                actualChanges[to] = (actualChanges[to] ?? new BN(0)).plus(value);
            }
        }
        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];
            const address = typeof account == 'string'
                ? account
                : (account as Addressable).getAddress
                    ? await (account as Addressable).getAddress()
                    : await account;
            const change = actualChanges[address as string] ?? new BN(0);
            expect(change).eq(changes[i]);
        }
    } else {
        await expect(tx).changeTokenBalances(token, accounts, changes.map(it => it.toString()));
    }
}
