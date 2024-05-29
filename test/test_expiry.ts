import {time} from "@nomicfoundation/hardhat-network-helpers";
import {currentBlockTime, getZkTestProvider, OrderCloseReason, OrderSide, setUpTest, submitOrderHelper} from "./utils";
import {expect} from "chai";
import hre from "hardhat";

describe("Blackbox testing OrderBook contract", async () => {
    it("Submit expired order should fail", async () => {
        const load = await setUpTest();
        const amount = load.fmtUsdc(10);
        await load.approveSpending(load.USDC, load.bob, amount);
        await expect(
            load.OrderBookContract.connect(load.bob)
                .submitOrder(OrderSide.BUY, load.fmtPrice(3000), amount, await currentBlockTime() - 1, [])
        ).to.be.revertedWith("Invalid validUntil");
    });

    it("Expired order shouldn't be filled", async () => {
        const load = await setUpTest();
        const amount = load.fmtUsdc(100);
        await load.approveSpending(load.USDC, load.bob, amount);

        const makerOrderId = await submitOrderHelper(
            load.OrderBookContract, load.bob, OrderSide.BUY,
            load.fmtPrice(3000), amount, load.expireAfter(1, 'day')
        );
        const nextTimestamp = await load.expireAfter(2, 'day');
        if (hre.network.zksync) {
            await getZkTestProvider()
                .send("evm_setNextBlockTimestamp", [nextTimestamp]);
        } else {
            await time.increaseTo(nextTimestamp);
        }

        const takerAmount = load.fmtWeth(1);
        await load.approveSpending(load.WETH, load.alice, takerAmount);
        await submitOrderHelper(
            load.OrderBookContract, load.alice, OrderSide.SELL,
            load.fmtPrice(3000), takerAmount, load.expireAfter(7, 'day'),
            [makerOrderId], async (tx) => {
                await expect(tx).to.emit(load.OrderBookContract, "OrderClosedEvent")
                    .withArgs(makerOrderId, load.bob.address, 0, 0, 0, OrderSide.BUY, OrderCloseReason.EXPIRED);
            }
        );
    });
});