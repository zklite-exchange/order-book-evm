import hre from "hardhat";
import BN from "bignumber.js";
import {expect} from "chai";
import {DurationInputArg1, DurationInputArg2} from "moment";
import moment from "moment/moment";
import {OrderBook} from "../typechain";
import type {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {BigNumberish, type ContractTransactionResponse} from "ethers";

export enum OrderSide {
    BUY = 0,
    SELL = 1,
}

export enum OrderCloseReason {
    FILLED = 0, CANCELLED, EXPIRED, OUT_OF_BALANCE, OUT_OF_ALLOWANCE
}

export async function deployFakeTokens(owner: any) {
    const WETH = await hre.ethers.deployContract("WETH", owner);
    const USDC = await hre.ethers.deployContract("USDC", owner);
    return {
        WETH, USDC
    };
}

export async function setUpTest() {
    const [alice, bob] = await hre.ethers.getSigners();
    const {WETH, USDC} = await deployFakeTokens(alice);
    const ethDecimalPow = `1e${Number(await WETH.decimals())}`;
    const usdcDecimalPow = `1e${Number(await USDC.decimals())}`;
    await WETH.transfer(bob.address, new BN(100).times(ethDecimalPow).dp(0).toString());
    await USDC.transfer(bob.address, new BN(15000).times(usdcDecimalPow).dp(0).toString());

    //deploy contract
    const takerFeeBps = 0.1 / 0.01; // 0.1% = 10 basis points
    const makerFeeBps = 0.1 / 0.01; // 0.1% = 10 basis points
    const priceDecimals = 20;
    const minQuote = new BN(5).times(usdcDecimalPow).toString(); // 5 USDC
    const orderBookConstructorArgs = [
        alice.address,
        await WETH.getAddress(), await USDC.getAddress(),
        priceDecimals, minQuote, takerFeeBps, makerFeeBps
    ];
    const OrderBookContract = await hre.ethers.deployContract("OrderBook", orderBookConstructorArgs);
    expect(await OrderBookContract.minQuote()).to.equal(minQuote);
    expect(await OrderBookContract.makerFeeBps()).to.equal(makerFeeBps);
    expect(await OrderBookContract.takerFeeBps()).to.equal(takerFeeBps);
    expect(await OrderBookContract.priceDecimals()).to.equal(priceDecimals);
    expect(await OrderBookContract.baseToken()).to.equal(await WETH.getAddress());
    expect(await OrderBookContract.quoteToken()).to.equal(await USDC.getAddress());
    const priceDecimalPow = `1e${priceDecimals}`;
    return {
        alice, bob, WETH, USDC, OrderBookContract,
        takerFeeBps, makerFeeBps, minQuote,
        usdcDecimalPow, ethDecimalPow, priceDecimalPow,
        fmtUsdc: (value: BN.Value) => new BN(value).times(usdcDecimalPow).toString(),
        fmtWeth: (value: BN.Value) => new BN(value).times(ethDecimalPow).toString(),
        fmtPrice: (price: BN.Value) => new BN(price).times(usdcDecimalPow).times(priceDecimalPow)
            .div(ethDecimalPow).toString(),
        expireAfter: (amount: DurationInputArg1, unit: DurationInputArg2) => moment().add(amount, unit).unix()
    };
}

export const submitOrderHelper = async (
    contract: OrderBook, owner: HardhatEthersSigner,
    side: OrderSide, price: BigNumberish, amount: BigNumberish,
    validUtil?: BigNumberish,
    orderIdsToFill?: BigNumberish[],
    extraExpect?: (tx: Promise<ContractTransactionResponse>) => Promise<void>
): Promise<bigint> => {
    validUtil = validUtil ?? moment().add(1, 'day').unix();
    let orderId = 0n;
    const tx = contract.connect(owner)
        .submitOrder(side, price, amount, validUtil, orderIdsToFill ?? []);
    await expect(tx).to.emit(contract, "NewOrderEvent")
        .withArgs(
            (_orderId: bigint) => {
                orderId = _orderId;
                return true;
            },
            owner, price, amount, side, validUtil
        );
    if (extraExpect) {
        await extraExpect(tx);
    }
    expect(orderId).gt(0);
    return orderId;
};