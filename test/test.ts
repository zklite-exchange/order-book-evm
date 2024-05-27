import {expect} from "chai";
import hre from "hardhat";
import {loadFixture} from "@nomicfoundation/hardhat-network-helpers";
import {deployFakeTokens} from "./utils";
import BigNumber from "bignumber.js";
import moment from "moment";
import {DurationInputArg1, DurationInputArg2} from "moment/moment";
import {OrderBook} from "../typechain";
import type {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {BigNumberish, type ContractTransactionResponse} from "ethers";
import {anyValue} from "@nomicfoundation/hardhat-chai-matchers/withArgs";

enum OrderSide {
    BUY = 0,
    SELL = 1,
}

enum OrderCloseReason {
    FILLED = 0, CANCELLED, EXPIRED, OUT_OF_BALANCE, OUT_OF_ALLOWANCE
}

const BN = BigNumber;

describe("Blackbox testing OrderBook contract", async () => {
    async function setUp() {
        const [alice, bob] = await hre.ethers.getSigners();
        const {WETH, USDC} = await deployFakeTokens(alice);
        const ethDecimalPow = `1e${Number(await WETH.decimals())}`;
        const usdcDecimalPow = `1e${Number(await USDC.decimals())}`;
        await WETH.transfer(bob.address, new BigNumber(100).times(ethDecimalPow).dp(0).toString());
        await USDC.transfer(bob.address, new BigNumber(10000).times(usdcDecimalPow).dp(0).toString());

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
            fmtUsdc: (value: BigNumber.Value) => new BigNumber(value).times(usdcDecimalPow).toString(),
            fmtWeth: (value: BigNumber.Value) => new BigNumber(value).times(ethDecimalPow).toString(),
            fmtPrice: (price: BigNumber.Value) => new BigNumber(price).times(usdcDecimalPow).times(priceDecimalPow)
                .div(ethDecimalPow).toString(),
            expireAfter: (amount: DurationInputArg1, unit: DurationInputArg2) => moment().add(amount, unit).unix()
        };
    }

    const submitOrderHelper = async (
        contract: OrderBook, owner: HardhatEthersSigner,
        side: OrderSide, price: BigNumberish, amount: BigNumberish,
        validUtil: BigNumberish,
        orderIdsToFill?: BigNumberish[],
        extraExpect?: (tx: Promise<ContractTransactionResponse>) => Promise<void>
    ): Promise<bigint> => {
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

    it("Normal use case: submit order and cancel order", async () => {
        const load = await loadFixture(setUp);
        for (let side = OrderSide.BUY; side <= OrderSide.SELL; side++) {
            const amount = side == OrderSide.BUY ? load.fmtUsdc(100) : load.fmtWeth(1);
            const price = load.fmtPrice(3000);
            const validUtil = load.expireAfter(7, 'days');
            await (side == OrderSide.BUY ? load.USDC : load.WETH)
                .connect(load.bob)
                .approve(await load.OrderBookContract.getAddress(), amount);
            const orderId = await submitOrderHelper(load.OrderBookContract, load.bob, side, price, amount, validUtil);
            console.log("orderId", orderId);

            expect(await load.OrderBookContract.getActiveOrderIds()).to.contain(orderId);
            expect(await load.OrderBookContract.getActiveOrderIdsOf(load.bob.address)).to.contain(orderId);

            let order = await load.OrderBookContract.getOrder(orderId);
            expect(order.id).eq(orderId);
            expect(order.side).eq(side);
            expect(order.price).eq(price);
            expect(order.amount).eq(amount);
            expect(order.validUntil).eq(validUtil);
            expect(order.owner).eq(load.bob.address);

            await expect(
                load.OrderBookContract.connect(load.bob).cancelOrder(orderId)
            ).to.emit(load.OrderBookContract, "OrderClosedEvent")
                .withArgs(orderId, load.bob.address, 0, 0, 0, side, OrderCloseReason.CANCELLED);

            expect(await load.OrderBookContract.getActiveOrderIds()).to.not.contain(orderId);
            expect(await load.OrderBookContract.getActiveOrderIdsOf(load.bob.address)).to.not.contain(orderId);
            order = await load.OrderBookContract.getOrder(orderId);
            // check order is zero-ed
            expect(order.id).eq(0);
            expect(order.price).eq(0);
            expect(order.amount).eq(0);
        }
    });

    it("Normal use case: Fill order 100% amount", async () => {
        const load = await loadFixture(setUp);
        for (let takerSide = OrderSide.BUY; takerSide <= OrderSide.SELL; takerSide++) {
            const taker = load.bob;
            const maker = load.alice;

            let takerAmount;
            let makerAmount;
            let takerPrice;
            let makerPrice;
            let makerSide;

            let takerSellToken;
            let takerBuyToken;

            if (takerSide == OrderSide.BUY) {
                makerAmount = load.fmtWeth(1);
                makerPrice = load.fmtPrice(3000); // exchange 1ETH for 3000 USDC
                makerSide = OrderSide.SELL;

                takerPrice = load.fmtPrice(4000);
                takerAmount = load.fmtUsdc(3000); // exchange 3000 USDC for at least 0.75 ETH, ends up got 1 ETH

                takerSellToken = load.USDC;
                takerBuyToken = load.WETH;

                await load.WETH.connect(maker).approve(await load.OrderBookContract.getAddress(), makerAmount);
                await load.USDC.connect(taker).approve(await load.OrderBookContract.getAddress(), takerAmount);
            } else {
                makerAmount = load.fmtUsdc(3000);
                makerPrice = load.fmtPrice(3000); // exchange 3000 USDC for 1 ETH
                makerSide = OrderSide.BUY;

                takerPrice = load.fmtPrice(2000);
                takerAmount = load.fmtWeth(1); // exchange 1 ETH for at least 2000 USDC, ends up GOT 3000 USDC

                takerSellToken = load.WETH;
                takerBuyToken = load.USDC;

                await load.WETH.connect(taker).approve(await load.OrderBookContract.getAddress(), takerAmount);
                await load.USDC.connect(maker).approve(await load.OrderBookContract.getAddress(), makerAmount);
            }

            const takerReceiveAmt = makerAmount;
            const takerFee = new BN(takerReceiveAmt).times(load.takerFeeBps).div(10000).dp(0).toString();

            const makerReceiveAmt = takerAmount;
            const makerFee = new BN(makerReceiveAmt).times(load.makerFeeBps).div(10000).dp(0).toString();

            const makerOrderId = await submitOrderHelper(
                load.OrderBookContract, maker, makerSide, makerPrice, makerAmount,
                load.expireAfter(7, 'days')
            );

            await submitOrderHelper(
                load.OrderBookContract, taker, takerSide, takerPrice, takerAmount,
                load.expireAfter(7, 'days'), [makerOrderId],
                async (tx) => {
                    await expect(tx)
                        .emit(load.OrderBookContract, "FillEvent")
                        .withArgs(
                            makerOrderId, anyValue, maker.address, taker.address,
                            takerSide == OrderSide.BUY ? takerAmount : makerAmount,
                            takerSide == OrderSide.BUY ? makerAmount : takerAmount,
                            takerFee, makerFee, takerSide
                        )
                        .and.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(makerOrderId, maker.address, makerReceiveAmt, makerAmount, makerFee, makerSide, OrderCloseReason.FILLED)
                        .and.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(anyValue, taker.address, takerReceiveAmt, takerAmount, takerFee, takerSide, OrderCloseReason.FILLED);

                    await expect(tx)
                        .changeTokenBalances(
                            takerSellToken,
                            [taker, maker],
                            [
                                new BN(takerAmount).times(-1).toString(),
                                new BN(makerReceiveAmt).minus(makerFee).toString()
                            ]);
                    await expect(tx)
                        .changeTokenBalances(
                            takerBuyToken,
                            [taker, maker],
                            [
                                new BN(takerReceiveAmt).minus(takerFee).toString(),
                                new BN(makerAmount).times(-1).toString()
                            ]);
                }
            );
        }
    });


});